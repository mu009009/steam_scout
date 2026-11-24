// LLM 客户端：OpenAI 兼容接口（默认 DeepSeek），支持流式输出与工具调用
import { CONFIG } from './config.mjs';
import { sleep } from './util.mjs';
import { DeltaFilter } from './toolcall-repair.mjs';

export class LLMError extends Error {}

/** 单次输出上限的降级阶梯（服务商能力不同：DeepSeek chat 8K / reasoner 64K、OpenAI 16K…） */
const MAX_TOKENS_LADDER = [32768, 16384, 8192, 4096];
/** 进程级记忆：服务商实际接受的单次输出上限，避免每次都先撞一次墙 */
let acceptedMaxTokens = null;
export function effectiveMaxTokens() { return acceptedMaxTokens ?? CONFIG.llm.maxTokens; }

export function llmConfigured() { return Boolean(CONFIG.llm.apiKey); }

async function postChat(body, { stream = false, onDelta, onReasoning } = {}) {
  const { baseUrl, apiKey, model, timeoutMs } = CONFIG.llm;
  if (!apiKey) throw new LLMError('LLM 未配置：请在项目根目录的 .env 文件中设置 DEEPSEEK_API_KEY 后重启（参考 .env.example）');
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  // 配置给的是"想要的上限"；被服务商拒绝时按阶梯逐级降级，并把结果记住（进程级）
  let wantTok = Math.min(
    Number(body.max_tokens ?? CONFIG.llm.maxTokens) || CONFIG.llm.maxTokens,
    Number(acceptedMaxTokens ?? CONFIG.llm.maxTokens) || CONFIG.llm.maxTokens,
  );
  let reqBody = { ...body, max_tokens: wantTok };

  for (let attempt = 0; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, stream, ...reqBody }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw new LLMError(`LLM 请求失败: ${e.message}`);
    }

    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 300);
      // 服务商嫌 max_tokens 太大 → 降一档重试（不影响其它错误处理）
      if (res.status === 400 && /max_tokens|max output|maximum|too large|invalid.*token/i.test(errText)) {
        const next = MAX_TOKENS_LADDER.find((v) => v < Number(reqBody.max_tokens ?? 0));
        if (next) {
          console.warn(`[llm] 服务商不支持 max_tokens=${reqBody.max_tokens}，自动降到 ${next}（本次运行记住该上限）`);
          acceptedMaxTokens = next;
          reqBody = { ...reqBody, max_tokens: next };
          continue;
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      throw new LLMError(`LLM API 错误 HTTP ${res.status}: ${errText}`);
    }

    if (!stream) {
      const j = await res.json().catch(() => null);
      if (!j) throw new LLMError('LLM 返回了非 JSON 响应');
      const choice = j.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      return { content: msg.content ?? '', toolCalls: msg.tool_calls ?? [], usage: j.usage, finishReason: choice.finish_reason ?? '' };
    }

    // ---- 流式解析 SSE ----
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    let finishReason = '';
    const toolAcc = new Map(); // index -> {id, name, args}
    const order = [];
    // 有些模型会把工具调用写成正文（DSML 标记），这类标记不能流到界面上
    const deltaFilter = new DeltaFilter();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let j;
          try { j = JSON.parse(payload); } catch { continue; }
          const choice = j.choices?.[0];
          if (!choice) continue;
          const d = choice.delta ?? {};
          if (typeof d.content === 'string' && d.content) {
            content += d.content;
            const safe = deltaFilter.push(d.content);
            if (safe) { try { onDelta?.(safe); } catch {} }
          }
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) { reasoning += d.reasoning_content; try { onReasoning?.(d.reasoning_content); } catch {} }
          if (choice.finish_reason) finishReason = choice.finish_reason;
          for (const tc of d.tool_calls ?? []) {
            const i = tc.index ?? 0;
            if (!toolAcc.has(i)) { toolAcc.set(i, { id: tc.id ?? '', name: '', args: '' }); order.push(i); }
            const acc = toolAcc.get(i);
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      if (attempt < 2 && !content && toolAcc.size === 0) { await sleep(1500 * (attempt + 1)); continue; }
      throw new LLMError(`LLM 流式响应中断: ${e.message}`);
    }
    const toolCalls = order
      .map((i) => toolAcc.get(i))
      .filter((v) => v && v.name)
      .map((v) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.args || '{}' } }));
    // 把过滤器里残留的正文吐出来（正常文本不受影响）
    const tail = deltaFilter.flush();
    if (tail) { try { onDelta?.(tail); } catch {} }
    // 推理型模型（如 deepseek-flash/reasoner）可能把全部输出放进 reasoning_content，
    // 导致流式 content 为空：用非流式请求重试兜底
    if (!content && toolCalls.length === 0) {
      return postChat(reqBody, { stream: false });
    }
    return { content, toolCalls, finishReason, reasoningLength: reasoning.length };
  }
  throw new LLMError('LLM 请求失败');
}

export async function chat({ messages, tools = null, temperature, maxTokens, onDelta = null, onReasoning = null }) {
  const stream = Boolean(onDelta) || Boolean(onReasoning);
  const body = {
    messages,
    temperature: temperature ?? CONFIG.llm.temperature,
    max_tokens: maxTokens ?? CONFIG.llm.maxTokens,
  };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  return postChat(body, { stream, onDelta, onReasoning });
}

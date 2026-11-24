// 工具调用「格式修复」：有些模型会把工具调用写成正文（而不是 OpenAI 的 tool_calls 字段）。
// 典型是 DeepSeek 的 DSML 标记：
//   <｜｜DSML｜｜calls>
//   <｜｜DSML｜｜invoke name="evaluate_project">
//   <｜｜DSML｜｜parameter name="name" string="true">xxx</｜｜DSML｜｜parameter>
//   </｜｜DSML｜｜invoke>
// 另有 Anthropic 风格 <invoke name="x"><parameter .../></invoke>、<tool_call>{json}</tool_call>、
// 以及 ```json {"name":...,"arguments":{...}} ``` 代码块。
//
// 本模块做两件事：
//   1) extractPseudoToolCalls(text)：把这些文本解析回真正的工具调用（并返回清理后的正文）
//   2) DeltaFilter：流式输出时把这类标记挡在正文之外，避免用户看到"乱码"

/** 是否像工具调用标记的开头（用于流式缓冲判断） */
function looksLikeMarkupStart(s) {
  if (s.includes('<')) return true;
  return /DSML/i.test(s.slice(0, 24));
}

const INVOKE_CLOSED = /<[^>\n]{0,40}?\binvoke\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>\n]{0,40}?\binvoke\s*>/gi;
const INVOKE_OPEN_TAIL = /<[^>\n]{0,40}?\binvoke\b[^>]*?\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i;
const PARAM = /<[^>\n]{0,40}?\bparameter\b[^>]*?\bname\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/[^>\n]{0,40}?\bparameter\s*>/gi;
const TOOL_CALL_JSON = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const FENCED_JSON = /```(?:json)?\s*(\{[\s\S]{20,4000}?\})\s*```/gi;

function paramValue(attrs, raw) {
  const isString = /string\s*=\s*["']?true/i.test(attrs || '');
  const v = String(raw ?? '').trim();
  if (isString) return v;
  // 非字符串：尝试按 JSON 解析（数字/布尔/数组/对象）
  try { return JSON.parse(v); } catch { return v; }
}

function parseParams(body) {
  const args = {};
  for (const m of String(body || '').matchAll(PARAM)) {
    args[m[1]] = paramValue(m[2], m[3]);
  }
  return args;
}

/**
 * 从正文里解析出伪工具调用。
 * @returns {{ calls: Array<{name:string,args:object}>, cleaned: string, hadMarkup: boolean }}
 */
export function extractPseudoToolCalls(text) {
  const raw = String(text ?? '');
  if (!raw) return { calls: [], cleaned: raw, hadMarkup: false };
  const calls = [];
  let hadMarkup = false;
  let cleaned = raw;

  // 1) <…invoke name="X">…</…invoke>
  cleaned = cleaned.replace(INVOKE_CLOSED, (_all, name, body) => {
    hadMarkup = true;
    calls.push({ name: String(name).trim(), args: parseParams(body) });
    return '';
  });
  // 2) 未闭合的 invoke（流被截断）——能解析多少算多少
  const tail = cleaned.match(INVOKE_OPEN_TAIL);
  if (tail) {
    hadMarkup = true;
    const args = parseParams(tail[2]);
    if (Object.keys(args).length) calls.push({ name: String(tail[1]).trim(), args });
    cleaned = cleaned.slice(0, tail.index);
  }
  // 3) <tool_call>{json}</tool_call>
  cleaned = cleaned.replace(TOOL_CALL_JSON, (_all, body) => {
    hadMarkup = true;
    const obj = safeJson(body);
    const call = normalizeJsonCall(obj);
    if (call) calls.push(call);
    return '';
  });
  // 4) ```json {"name": "...", "arguments": {...}} ```
  cleaned = cleaned.replace(FENCED_JSON, (all, body) => {
    const obj = safeJson(body);
    const call = normalizeJsonCall(obj);
    if (!call) return all;
    hadMarkup = true;
    calls.push(call);
    return '';
  });

  // 5) 清掉残留标记（DSML 包裹、孤立闭合标签、空的 calls 壳）
  if (hadMarkup || /DSML/i.test(cleaned)) {
    cleaned = stripToolMarkup(cleaned);
  }
  return { calls, cleaned: tidy(cleaned), hadMarkup };
}

function safeJson(s) {
  const t = String(s ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { return null; }
}

function normalizeJsonCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.name ?? obj.tool ?? obj.function?.name ?? obj.tool_name;
  if (!name) return null;
  let args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? obj.function?.arguments ?? {};
  if (typeof args === 'string') args = safeJson(args) ?? {};
  if (!args || typeof args !== 'object') args = {};
  return { name: String(name).trim(), args };
}

/** 删除所有工具调用痕迹（含 DSML 包裹、整块 invoke 与孤立标签） */
export function stripToolMarkup(text) {
  let s = String(text ?? '');
  // 整块删除：<…invoke …>…</…invoke>（连参数体一起，避免参数值漏到正文）
  s = s.replace(/<[^>\n]{0,40}?\binvoke\b[^>]*>[\s\S]*?<\/[^>\n]{0,40}?\binvoke\s*>/gi, '');
  s = s.replace(/<[^>\n]{0,40}?\binvoke\b[^>]*>[\s\S]*$/i, '');      // 未闭合的 invoke
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  s = s.replace(/<tool_call>[\s\S]*$/i, '');
  s = s.replace(/<\s*[^>\n]{0,40}?DSML[^>\n]{0,40}?>/gi, '');          // <｜｜DSML｜｜calls> 之类
  s = s.replace(/<\/\s*[^>\n]{0,40}?DSML[^>\n]{0,40}?>/gi, '');
  s = s.replace(/<\/?[^>\n]{0,40}?\b(parameter|function_calls)\b[^>\n]{0,40}?>/gi, '');
  return s;
}

/** 清理多余空白：连续空行压成一个，去掉只含空白/标点的残行 */
function tidy(text) {
  return String(text ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s·•\-—]+$/gm, '')
    .trim();
}

/**
 * 流式输出过滤器：正文里的工具调用标记一律不外发。
 * 用法：onDelta(filter.push(chunk))，结束时 onDelta(filter.flush())。
 */
export class DeltaFilter {
  constructor() { this.held = ''; this.suppress = false; }

  push(chunk) {
    if (!chunk) return '';
    this.held += chunk;
    // 出现标记起始 → 进入抑制模式，直到标记结束（闭合标签或换行）
    if (!this.suppress && /<\s*[^>\n]{0,40}?(DSML|invoke|parameter|tool_call)\b/i.test(this.held)) {
      this.suppress = true;
    }
    if (this.suppress) {
      // 抑制模式下，若已出现明显的标记收尾（闭合参数/invoke/calls 或空行），尝试恢复
      if (/<\/\s*[^>\n]{0,40}?\b(invoke|calls|tool_call)\s*>/i.test(this.held) || /\n{2,}$/.test(this.held)) {
        const cleaned = stripToolMarkup(this.held);
        this.held = '';
        this.suppress = false;
        const t = tidy(cleaned);
        return t ? (t.endsWith('\n') ? t : t + '\n') : '';
      }
      // 防止无限抑制：内容过长就放弃抑制，交后续清理
      if (this.held.length > 4000) { this.suppress = false; const out = stripToolMarkup(this.held); this.held = ''; return out; }
      return '';
    }
    // 普通模式：把可能的标签起始留在缓冲里，等下一个分片再判断
    const lt = this.held.lastIndexOf('<');
    if (lt >= 0 && looksLikeMarkupStart(this.held.slice(lt))) {
      const safe = this.held.slice(0, lt);
      this.held = this.held.slice(lt);
      return safe;
    }
    const out = this.held;
    this.held = '';
    return out;
  }

  flush() {
    const rest = stripToolMarkup(this.held);
    this.held = '';
    this.suppress = false;
    return tidy(rest);
  }
}

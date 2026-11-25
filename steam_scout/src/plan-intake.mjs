// 排期信息抽取：LLM 驱动（主）+ 规则兜底（备）
//
// 为什么要 LLM 驱动：固定规则的追问只能问"预设的那几项"，而且判断依据是正则——
// 用户换个说法就漏判（比如"明年 6 月"曾经被判成"没说时间点"）。
// 现在交给模型做两件事：
//   ① 把用户最新一句话 + 之前已确认的信息，合并成结构化的排期 brief；
//   ② 自己判断"信息够不够"，不够就提出最关键的追问（最多 3 个，带候选答案）。
// 规则解析仍然保留，干两件事：给模型提供"已算好的日期/数字"提示（模型不擅长日期算术），
// 以及在模型不可用时兜底。
import { chat, llmConfigured } from './llm.mjs';
import { safeJsonParse, truncate } from './util.mjs';

const SYSTEM = `你是「立项排期信息抽取器」。任务：从对话中提取排期（周级甘特图）所需信息，判断信息是否足够，不够就提出最关键的追问。

输出**只允许** JSON，结构如下：
{
  "brief": {
    "name": "项目名（没有就给空字符串）",
    "genre": "品类（中文，如 肉鸽卡牌/模拟经营/幸存者like）",
    "team_size": 数字,
    "milestone": "Demo | 垂直切片 | EA | 上线",
    "target_state": "下一阶段要达成的状态，一句话",
    "chapters": 数字或0, "cards": 数字或0, "bosses": 数字或0,
    "levels": 数字或0, "characters": 数字或0, "words": 剧情字数或0,
    "deadline": "YYYY-MM-DD 或 null",
    "deadline_text": "用户关于时间的原话（例如 明年6月 / 对标6月新品节 / 没有时间点）",
    "no_deadline": true/false,
    "part_time": true/false,
    "done": ["已完成的项"]
  },
  "confidence": 0.0-1.0,
  "ready": true/false,
  "questions": [
    {"key": "scope|deadline|target|team|done|other:xxx", "q": "一句中文问题，给出示例", "options": ["候选回答1","候选回答2"]}
  ],
  "reason": "一句话说明为什么还需要这些信息（ready=true 时为空）"
}

硬性规则：
1. 只问**真正影响排期**的信息，最多 3 个问题；能从上下文合理推断的**不要问**。
2. 用户已明确说过「没有时间点 / 不确定 / 你定」→ 不要再问 deadline，把 no_deadline 置 true。
3. 输入里 given 字段给出「已确认的信息」，asked_keys 给出「已经问过的项」——**这些一律不要重复问**。
4. 用户这次说的内容**优先于**之前的信息（改了口径就以新的为准）。
5. deadline 只在能确定具体某天时填；只有"某月/年底/季度"时填 null，并把它记进 deadline_text（系统会用规则换算）。
6. 信息足够出排期时就置 ready=true 且 questions=[]；不要为了"更完整"而无限追问。`;

/** 用 LLM 抽取/合并排期信息；失败返回 null（调用方回退规则解析） */
export async function extractPlanBriefLLM({ userText, context = '', prevBrief = null, askedKeys = [], hints = null }) {
  if (!llmConfigured()) return null;
  const payload = {
    user_text: truncate(String(userText || ''), 2000),
    context: truncate(String(context || ''), 1200),
    given: prevBrief || {},
    asked_keys: askedKeys,
    rule_hints: hints || {},
  };
  try {
    const r = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `输入数据：\n${JSON.stringify(payload)}\n\n请输出 JSON。` },
      ],
      temperature: 0,
      maxTokens: 1200,
    });
    const j = safeJsonParse(String(r.content || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim(), null);
    if (!j || typeof j !== 'object' || !j.brief) return null;
    const b = j.brief || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const brief = {
      name: String(b.name || '').trim(),
      genre: String(b.genre || '').trim(),
      description: String(b.target_state || '').trim(),
      milestone: ['Demo', '垂直切片', 'EA', '上线'].includes(b.milestone) ? b.milestone : 'Demo',
      teamSize: Math.max(1, Math.min(50, num(b.team_size) || 3)),
      scope: {
        chapters: num(b.chapters), cards: num(b.cards), bosses: num(b.bosses),
        levels: num(b.levels), characters: num(b.characters), words: num(b.words),
      },
      targetState: String(b.target_state || '').trim(),
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline || '')) ? b.deadline : null,
      deadlineText: String(b.deadline_text || '').trim(),
      noDeadline: Boolean(b.no_deadline),
      partTime: Boolean(b.part_time),
      done: Array.isArray(b.done) ? b.done.map((x) => String(x)).slice(0, 10) : [],
    };
    const questions = (Array.isArray(j.questions) ? j.questions : [])
      .filter((q) => q && q.q)
      .slice(0, 3)
      .map((q) => ({
        key: String(q.key || 'other'),
        q: String(q.q).trim(),
        options: Array.isArray(q.options) ? q.options.map((o) => String(o)).slice(0, 3) : [],
      }));
    return {
      brief,
      ready: Boolean(j.ready),
      questions,
      reason: String(j.reason || ''),
      confidence: Number(j.confidence) || 0.5,
    };
  } catch {
    return null;
  }
}

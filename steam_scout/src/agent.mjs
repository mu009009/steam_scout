// Agent 核心：ReAct 工具调用主循环 + 立项评估流水线 + 学习沉淀
import { CONFIG } from './config.mjs';
import { chat, llmConfigured, LLMError } from './llm.mjs';
import { TOOLS, toolDefs, runTool } from './tools/index.mjs';
import { addConv, recentConvs, addInsight, counts, setMeta, upsertProject, addEvaluation } from './db.mjs';
import { search, invalidate } from './retriever.mjs';
import { runEvaluation, estimateDevTime } from './evaluator.mjs';
import { storeSearch, appDetails, appReviews, steamCharts, featuredCategories, popularTags, topTagIdFromRows, tagNameById, steamSearch, appTags } from './tools/steam.mjs';
import { searchVideos } from './tools/bilibili.mjs';
import { bingSearch } from './tools/websearch.mjs';
import { dataProviderStatus, enrichCompetitors } from './tools/paid-data.mjs';
import { truncate, safeJsonParse, parseJsonLoose, sleep } from './util.mjs';
import { cacheGet, cacheSet } from './research-cache.mjs';

export const SYSTEM_PROMPT = `你是「Steam 市场侦察兵」——一名专精 Steam 游戏市场的调研分析师与独立游戏立项顾问，运行在用户本机。

【你的知识背景】
本地知识库最初由 B 站 UP 主「Gaby学姐说」(https://space.bilibili.com/3546782527130177) 的 54 期视频观点播种：内容涵盖 Steam 独立游戏市场数据拆解、立项方法论、宣发全流程、爆款案例复盘（如 Friendslop、放置之路、玩具店大整理）。后续调研结论、市场复盘会不断沉淀进知识库。

【工作原则】
1. 涉及市场、竞品、趋势、立项的问题，必须先用工具获取实时数据（Steam 商店数据优先级高于记忆和猜测），再下结论。
2. 所有数据注明来源与日期；与知识库旧结论冲突时，以最新数据为准并说明变化。
3. 市场未来不可预测：不要铁口直断。给概率、给情景、给可复查的检查信号。
4. 面向小团队/独立开发者务实建议：钱、时间、人力都是稀缺资源。
5. 用中文回答，Markdown 排版，引用外部来源时给链接。
6. 关键数据点用 kb_add_insight 沉淀进知识库（只写有依据的内容）。
7. 工具结果可能被截断，属正常现象，必要时换参数再查。
8. 用户问"值不值得做/要多久/立项"时：先收集品类竞品数据（steam_store_search 的 released_desc/topselling/coming_soon 三个视角 + 竞品详情与在线 + 搜索趋势），再调用 evaluate_project 引擎出评分报告。
9. 本地项目档案：用 project_list 查看已评估项目，用 project_report 读取某项目的评估报告全文。用户说「输出项目X的评估结论」（或「回顾/查看项目X的报告」）时，必须先用 project_report 读到报告，再复述关键结论（评分/窗口/工期/建议），不要凭记忆猜测，也不要重新跑一次立项评估。
10. 工具调用要克制：一轮对话总调用次数有限（约 14 次），优先查最关键的数据，不要在同类查询上反复试探。
11. **提到具体游戏名时必须先核对**：用户说到某款游戏（如《幸存者笔记》）时，先用工具 steam_game_lookup 查证它的真实名称/标签/价格/评价；查到了就按标签判断品类，**查不到就明确说"Steam 上没查到这款游戏"**，并询问用户它的品类（给出几个候选），**绝对不要把游戏名猜成某个品类**（例如把"幸存者笔记"当成"幸存者like"）。`;

function detectMode(text) {
  const t = String(text).trim();
  // 读取档案类请求（输出/回顾/查看项目…结论、报告）走普通对话 + project_report 工具，绝不能触发新评估
  const archiveLookup = /(输出|回顾|查看|读取|展示|给我|导出).{0,12}(项目|档案)/.test(t) && /(结论|报告|评估结果|评估记录)/.test(t);
  if (archiveLookup) return 'chat';
  // 用户明确补充"品类/类型"（常见于澄清后的追问）→ 走评估
  if (/^(品类|类型|分类|赛道|genre|类型是|品类是)\s*[:：]?/i.test(t)) return 'eval';
  if (/评估|立项|值不值得|能不能做|值多少|做多久|多久.{0,6}(做|完成|开发|上线)|市场潜力|时机|可行性|可不可以做|还能.{0,6}(进场|入场|做)|红海|饱和|值不值得做/.test(t)) return 'eval';
  return 'chat';
}

// ---------- 工具结果摘要与序列化 ----------
function summarize(result, maxLen = 400) {
  const s = JSON.stringify(result);
  return truncate(s, maxLen);
}

function toToolMessage(result) {
  return truncate(JSON.stringify(result), 8000);
}

// ---------- ReAct 主循环 ----------
async function reactLoop(messages, emit, { maxRounds, session } = {}) {
  const rounds = maxRounds ?? CONFIG.agent.maxToolRounds;
  const maxCalls = CONFIG.agent.maxToolCalls ?? 14;
  let totalCalls = 0;
  for (let round = 0; round < rounds; round++) {
    // 达到工具调用上限后不再提供工具，强制模型汇总结论
    const offerTools = totalCalls < maxCalls;
    if (!offerTools && round === 0) emit({ type: 'status', text: '（已达调研工具调用上限，开始汇总结论）' });
    const resp = await chat({
      messages,
      tools: offerTools ? toolDefs : null,
      onDelta: (d) => emit({ type: 'delta', text: d }),
      onReasoning: (r) => emit({ type: 'reasoning', text: r }),
    });

    if (resp.toolCalls && resp.toolCalls.length) {
      totalCalls += resp.toolCalls.length;
      if (totalCalls >= maxCalls) emit({ type: 'status', text: `（已调用 ${totalCalls} 次工具，达到上限，开始汇总结论）` });
      messages.push({ role: 'assistant', content: resp.content || '', tool_calls: resp.toolCalls });
      for (const tc of resp.toolCalls) {
        const name = tc.function.name;
        let args = {};
        try { args = safeJsonParse(tc.function.arguments, {}); } catch {}
        emit({ type: 'tool', name, status: 'start', args });
        const r = await runTool(name, args, { emit, session });
        emit({ type: 'tool', name, status: r.ok ? 'end' : 'error', summary: r.ok ? summarize(r.result) : r.error });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: r.ok ? toToolMessage(r.result) : `工具执行失败: ${r.error}` });
      }
      continue;
    }
    return resp.content;
  }
  return (messages.findLast?.((m) => m.role === 'assistant' && m.content) || messages.filter((m) => m.role === 'assistant').pop())?.content ?? '（已达最大调研轮数，请基于已有数据总结）';
}

/** 为下一轮操作生成建议按钮（随消息持久化，重新打开/切换对话后依然可见） */
function buildSuggestions(mode, ctx = {}) {
  if (mode === 'eval' && ctx.projectName) {
    return [
      { type: 'message', label: `📌 输出项目「${ctx.projectName}」的评估结论`, text: `输出项目「${ctx.projectName}」的评估结论` },
      { type: 'message', label: '🔍 深挖该品类头部竞品与差异化机会', text: `继续分析「${ctx.genre || ''}」品类的头部竞品，给出 3 个可行的差异化切入方向` },
      { type: 'export', label: '⤓ 导出报告 PDF' },
    ];
  }
  const q = String(ctx.userMessage ?? '').slice(0, 100);
  // 只有看起来像游戏想法的消息才给「做成立项评估」按钮
  const looksLikeIdea = q.length >= 12 && /游戏|玩法|原型|做一款|开发|立项|模拟|肉鸽|roguelike|幸存者|卡牌|平台|经营|放置|沙盒/i.test(q);
  return [
    { type: 'message', label: '🔎 继续深入这个话题', text: '继续深入分析刚才的话题：补充更具体的竞品数据、失败案例与可执行建议' },
    ...(looksLikeIdea ? [{ type: 'message', label: '📊 把这个想法做成立项评估', text: `评估立项：${q}` }] : []),
    { type: 'message', label: '🧭 看看哪些品类在上升期', text: '2026 年哪些 Steam 品类处于上升期？适合小团队进场？' },
  ];
}

// ---------- 立项评估流水线 ----------
/** 从文本中提取可能的具体游戏名（《…》/「…」/引号） */
function extractGameTitles(text) {
  const out = [];
  for (const m of String(text).matchAll(/《([^》]{2,40})》/g)) out.push(m[1].trim());
  for (const m of String(text).matchAll(/「([^」]{2,40})」/g)) out.push(m[1].trim());
  for (const m of String(text).matchAll(/["“]([^"”\n]{2,40})["”]/g)) out.push(m[1].trim());
  return [...new Set(out)].filter(Boolean);
}

/** 在 Steam 上核对一个"游戏名"，返回匹配结果或 null（避免把新游误判成品类） */
async function lookupSteamGame(name, emit) {
  try {
    const norm = (s) => String(s).toLowerCase().replace(/[\s:：·\-—_®™'"“”]/g, '');
    const r = await steamSearch(name, 6);
    const target = norm(name);
    const hit = (r.items ?? []).find((it) => {
      const n = norm(it.name);
      return n === target || n.includes(target) || target.includes(n);
    });
    if (!hit) return { query: name, found: false, candidates: (r.items ?? []).slice(0, 3).map((i) => i.name) };
    const [detail, tags] = await Promise.all([
      appDetails(hit.appid).catch(() => null),
      appTags(hit.appid).catch(() => []),
    ]);
    const reviews = await appReviews(hit.appid).catch(() => null);
    const genreTags = (tags ?? []).filter((t) => GENRE_TAG_CANDIDATES.some((g) => t.toLowerCase().includes(g.toLowerCase()) || g.toLowerCase().includes(t.toLowerCase())));
    if (emit) emit({ type: 'status', text: `已识别游戏《${hit.name}》（Steam appid ${hit.appid}，标签：${(tags ?? []).slice(0, 6).join('、') || '无'}）` });
    return {
      query: name,
      found: true,
      appid: hit.appid,
      name: hit.name,
      tags: tags ?? [],
      genreTags,
      price: detail?.price ?? null,
      isFree: Boolean(detail?.isFree),
      releaseDate: detail?.releaseDate ?? '',
      reviews: reviews?.total ?? null,
      positivePct: reviews?.total ? Math.round((reviews.positive / reviews.total) * 100) : null,
      shortDescription: detail?.shortDescription ?? '',
    };
  } catch (e) {
    return { query: name, found: false, error: String(e.message || e) };
  }
}

async function parseBrief(text, context = '') {
  const ctx = context ? `\n\n【对话上下文（用于理解指代/补充信息）】\n${truncate(context, 1200)}` : '';
  if (llmConfigured()) {
    try {
      const sys = '你是游戏立项信息提取助手。从用户描述提取 JSON：{"name","genre","description","dimension","scope","team_size","experience"}。genre 用中文品类名（如 肉鸽卡牌/模拟经营/幸存者like/2D平台跳跃/3D动作）；dimension 填 2D 或 3D；scope 填 小型/中型/大型；team_size 为数字；experience 填 新手/有经验/资深。**如果用户没说品类或说得含糊，genre 留空字符串，不要瞎猜。** 未提及的其它字段给默认值。只输出 JSON。';
      const r = await chat({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text + ctx }],
        temperature: 0,
        onReasoning: (t) => emit({ type: 'reasoning', text: t }),
      });
      const j = safeJsonParse(String(r.content).replace(/```json|```/g, '').trim(), null);
      if (j && typeof j === 'object') {
        return {
          name: j.name || '未命名项目',
          genre: j.genre || '',
          description: j.description || text.slice(0, 300),
          dimension: j.dimension || '',
          scope: j.scope || '',
          teamSize: Math.max(1, Math.round(Number(j.team_size) || 1)),
          experience: j.experience || '有经验',
        };
      }
    } catch { /* 回退到规则 */ }
  }
  const nameM = text.match(/《([^》]{1,30})》/) || text.match(/["“]([^"”]{1,30})["”]/);
  // 团队人数：2人/两个人/三人团队/单人/独立开发
  let teamSize = 1;
  const teamM = text.match(/(\d+)\s*人|([两三四五六七八九十])\s*人|单人|一个人|独立开发/);
  if (teamM) {
    const cn = { 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    teamSize = teamM[1] ? Number(teamM[1]) : teamM[2] ? (cn[teamM[2]] ?? 2) : 1;
    teamSize = Math.max(1, Math.round(teamSize));
  }
  let experience = '有经验';
  if (/新手|第一次|零经验|没做过|学生/.test(text)) experience = '新手';
  if (/资深|十年|10年|老手|上线过/.test(text)) experience = '资深';
  const dev = estimateDevTime({ genre: '', description: text, teamSize });
  return { name: nameM ? nameM[1] : '未命名项目', genre: dev.genreLabel, description: text.slice(0, 300), dimension: dev.dimension, scope: '', teamSize, experience };
}

// 品类专属标签（优先匹配）；泛标签（单人/独立/动作等）只在没有品类标签时兜底
const GENRE_TAG_CANDIDATES = [
  'Roguelike', 'Roguelite', '肉鸽', '牌组构建', '卡牌', '卡牌游戏', 'Card Game', '爬塔', 'Deckbuilder',
  '模拟', 'Simulation', '生活模拟', '钓鱼', 'Fishing', '生存', 'Survival', '平台游戏', 'Platformer', '银河战士恶魔城', 'Metroidvania',
  '恐怖', 'Horror', '放置', 'Idler', '农场', 'Farming Sim', '建造', 'City Builder', '解谜', 'Puzzle', '视觉小说', 'Visual Novel',
  '塔防', 'Tower Defense', '沙盒', 'Sandbox', '物理', 'Physics',
  '幸存者', '类幸存者', '吸血鬼幸存者', 'Survivors', 'Vampire Survivors',
];
const GENERIC_TAG_CANDIDATES = ['单人', 'Singleplayer', '多人', 'Multiplayer', '独立', 'Indie', '动作', 'Action', '休闲', 'Casual', '策略', 'Strategy', '角色扮演', 'RPG'];

/** 解析发布日期为时间戳（支持 2026年10月1日 / 1 Oct, 2026 / 2026 等格式） */
function parseReleaseTs(s) {
  if (!s) return null;
  const zh = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (zh) return new Date(Number(zh[1]), Number(zh[2]) - 1, 1).getTime();
  const ym = s.match(/(\d{1,2})\s*月\s*(\d{4})/);
  if (ym) return new Date(Number(ym[2]), Number(ym[1]) - 1, 1).getTime();
  const en = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (en) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mi = months[en[1].slice(0, 3).toLowerCase()];
    if (mi != null) return new Date(Number(en[3]), mi, 1).getTime();
  }
  const y = s.match(/(19|20)\d{2}/);
  return y ? new Date(Number(y[0]), 0, 1).getTime() : null;
}

// Steam 搜索缓存（10 分钟，进程内）+ 快速失败（Steam 限流时最多 2 次尝试）
async function storeSearchCached(params) {
  const key = JSON.stringify(params);
  const hit = cacheGet(key);
  if (hit) return hit;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await storeSearch(params);
      cacheSet(key, r);
      return r;
    } catch (e) {
      lastErr = e;
      if (i < 1) await sleep(2500);
    }
  }
  throw lastErr;
}

async function popularTagsRetry() {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try { return await popularTags(); } catch (e) { lastErr = e; if (i < 2) await sleep(3000 * (i + 1)); }
  }
  throw lastErr;
}

async function researchMarket(brief, emit) {
  const research = { genre: brief.genre, competitors: [], releasesByYear: {}, upcomingCount: null, articles: [], videos: [], kb: [], topGameAgeMonths: null, chineseShare: null, tagName: null, dataSource: null };
  const step = (text) => emit({ type: 'status', text });
  // 总时间预算：Steam 被限流时避免把用户挂几分钟；超预算就带着已有数据进入评分（报告会标注缺口）
  const deadline = Date.now() + 90_000;
  const overBudget = () => Date.now() > deadline;
  let skipped = 0;
  const skipNote = (what) => { skipped++; step(`⏱️ 数据采集超时（Steam 可能限流），跳过${what}，本次评分将标注数据缺口`); };

  // 1. 品类标签定位：品类标签 > 关键词反推 > 泛标签兜底
  step(`正在定位品类标签…`);
  const hay = `${brief.genre} ${brief.description}`;
  const collect = (cands) => {
    const words = new Set();
    for (const c of cands) {
      if (hay.includes(c) || (c.length > 2 && hay.toLowerCase().includes(c.toLowerCase()))) words.add(c);
    }
    return words;
  };
  const pickFrom = async (words) => {
    if (!words.size) return null;
    const tags = await popularTagsRetry();
    const found = [];
    for (const w of words) {
      const t = tags.find((x) => x.name === w) || tags.find((x) => x.name.includes(w));
      if (t) found.push({ t, idx: tags.findIndex((x) => x.tagid === t.tagid) });
    }
    found.sort((a, b) => b.idx - a.idx); // popularTags 按热度排序，越靠后越小众 → 优先
    return found[0]?.t ?? null;
  };
  let tag = null;
  try { tag = await pickFrom(collect(GENRE_TAG_CANDIDATES)); } catch {}
  // 品类标签未命中：关键词搜索结果行的高频标签反推（覆盖热门榜之外的细分标签，如幸存者like）
  if (!tag) {
    try {
      const probe = await storeSearchCached({ term: brief.genre.replace(/[\/｜|·]/g, ' '), sort: 'released_desc', limit: 50 });
      const inferred = topTagIdFromRows(probe.rows, 5);
      if (inferred) {
        let name = null;
        try {
          name = (await popularTagsRetry()).find((x) => x.tagid === inferred.tagid)?.name ?? null;
        } catch {}
        if (!name) name = await tagNameById(inferred.tagid).catch(() => null);
        tag = { tagid: inferred.tagid, name: name ?? `#${inferred.tagid}` };
      }
    } catch {}
  }
  // 仍无标签：泛标签兜底（单人/独立/动作等）
  if (!tag) {
    try { tag = await pickFrom(collect(GENERIC_TAG_CANDIDATES)); } catch {}
  }
  research.tagName = tag?.name ?? null;
  step(tag ? `品类标签：${tag.name}` : '（标签定位失败，改用关键词搜索）');
  const termFallback = tag ? null : brief.genre.replace(/[\/｜|·]/g, ' ');

  // 2. 新游发行趋势（最多 300 条，按年聚合）
  step(tag ? `正在拉取「${tag.name}」品类新游发行数据…` : '正在拉取新游发行数据…');
  let releaseRows = [];
  if (overBudget()) { skipNote('新游发行数据'); }
  else try {
    for (let page = 0; page < 3 && releaseRows.length < 300; page++) {
      if (overBudget()) break;
      const r = await storeSearchCached({ tagId: tag?.tagid, term: termFallback, sort: 'released_desc', limit: 100, page });
      releaseRows.push(...r.rows);
      if (r.rows.length < 100) break;
      await sleep(300);
    }
    emit({ type: 'tool', name: 'steam_store_search', status: 'end', summary: `新游列表 ${releaseRows.length} 条` });
  } catch (e) { emit({ type: 'tool', name: 'steam_store_search', status: 'error', summary: truncate(e.message, 200) }); }
  for (const row of releaseRows) {
    const y = row.released.match(/(19|20)\d{2}/)?.[0];
    if (y) research.releasesByYear[y] = (research.releasesByYear[y] || 0) + 1;
  }
  {
    const yearParts = Object.entries(research.releasesByYear).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 3).map(([y, n]) => `${y}年${n}款`).join(' / ');
    if (releaseRows.length) step(`已采集新游发行记录 ${releaseRows.length} 条${yearParts ? `（${yearParts}）` : ''}`);
    else step('⚠️ 未获取到新游发行记录（接口限流或标签不匹配），将影响趋势与竞争判断');
  }

  // 3. 热销竞品详情
  step('正在获取热销竞品详情与在线数据…');
  let topRows = [];
  if (!overBudget()) {
    try {
      const r = await storeSearchCached({ tagId: tag?.tagid, term: termFallback, sort: 'topselling', limit: 30 });
      topRows = r.rows;
    } catch {}
  } else skipNote('热销竞品列表');
  const topCandidates = topRows.filter((r) => r.appid).slice(0, 6);
  for (const row of topCandidates) {
    if (overBudget()) break;
    try {
      const detail = await appDetails(row.appid).catch(() => null);
      if (!detail || detail.error) continue;
      let reviews = row.reviews ?? null;
      let positivePct = row.positivePct ?? null;
      if (reviews == null) {
        const rv = await appReviews(row.appid).catch(() => null);
        if (rv?.total) {
          reviews = rv.total;
          positivePct = Math.round((rv.positive / rv.total) * 100);
        }
      }
      const relTs = parseReleaseTs(detail.releaseDate);
      research.competitors.push({
        appid: row.appid,
        name: detail.name,
        price: detail.isFree ? 0 : (row.price ?? null),
        reviews,
        positivePct,
        releaseYear: relTs ? new Date(relTs).getFullYear() : null,
        releaseTs: relTs,
        chineseSupported: detail.chineseSupported,
        peak24h: null,
      });
    } catch {}
  }
  // 头部 3 款在线人数
  for (const c of research.competitors.slice(0, 3)) {
    try { const ch = await steamCharts(c.appid); c.peak24h = ch.peak24h; } catch {}
  }
  // 3.5 可选第三方/付费数据源补充（只有配置了 DATA_PROVIDER 才走，只补官方接口缺失的字段）
  const provStatus = dataProviderStatus();
  if (provStatus.configured && research.competitors.length && !overBudget()) {
    step(`正在用数据源「${provStatus.label}」补充官方接口缺失的字段（拥有者/在线/评价）…`);
    try {
      const r = await enrichCompetitors(research.competitors, emit, { maxCalls: 6, budgetMs: 25000 });
      if (r.sourceUsed) {
        research.dataSource = r.sourceUsed;
        step(`数据源「${r.sourceUsed}」补充完成：${research.competitors.filter((c) => c.dataSource).length} 款竞品拿到补充数据`);
        emit({ type: 'tool', name: 'data_provider', status: 'end', summary: r.sourceUsed });
      } else {
        step(`数据源「${provStatus.label}」未返回有效数据（可能 key 无效/额度用尽），继续用官方接口数据`);
        emit({ type: 'tool', name: 'data_provider', status: 'error', summary: '无有效返回' });
      }
    } catch (e) {
      step(`⚠️ 数据源调用异常（${truncate(String(e.message || e), 60)}），继续用官方接口数据`);
      emit({ type: 'tool', name: 'data_provider', status: 'error', summary: truncate(String(e.message || e), 150) });
    }
  } else if (provStatus.configured && !research.competitors.length) {
    step('（未取到竞品基础数据，跳过第三方数据源补充）');
  }
  const zhTotal = research.competitors.filter((c) => c.chineseSupported != null).length;
  research.chineseShare = zhTotal ? research.competitors.filter((c) => c.chineseSupported).length / zhTotal : null;
  if (research.competitors.length) {
    const hasCharts = research.competitors.some((c) => c.peak24h);
    step(`已采集热销竞品 ${research.competitors.length} 款（价格/评价数/好评率${hasCharts ? '/在线峰值' : ''}）`);
    emit({
      type: 'tool', name: 'steam_app_details', status: 'end',
      summary: research.competitors.slice(0, 4).map((c) => `${c.name}${c.price != null ? ` ¥${c.price}` : ''}${c.positivePct != null ? ` ${c.positivePct}%好评` : ''}`).join('、'),
    });
  } else {
    step('⚠️ 未能获取热销竞品详情（接口限流或品类过于小众），评分置信度将下降');
  }
  // 头部爆款年龄（月级精度）
  const topByReviews = [...research.competitors].sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0))[0];
  if (topByReviews?.releaseTs && (topByReviews.reviews ?? 0) > 2000) {
    research.topGameAgeMonths = Math.max(0, Math.round((Date.now() - topByReviews.releaseTs) / (30.44 * 86400000)));
  }
  // 近期爆款检测：18 个月内、评价过万的最大爆款年龄（热点驱动信号）
  const recentCut = Date.now() - 18 * 30.44 * 86400000;
  const recentHits = research.competitors.filter((c) => c.releaseTs && c.releaseTs >= recentCut && (c.reviews ?? 0) > 10000);
  if (recentHits.length) {
    const biggest = [...recentHits].sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0))[0];
    research.recentHitAgeMonths = Math.max(0, Math.round((Date.now() - biggest.releaseTs) / (30.44 * 86400000)));
  }

  // 4. 即将上线竞品
  if (!overBudget()) {
    try {
      const up = await storeSearchCached({ tagId: tag?.tagid, term: termFallback, sort: 'coming_soon', limit: 50 });
      research.upcomingCount = up.total ?? up.count;
    } catch {}
  } else skipNote('即将上线数量');
  step(research.upcomingCount != null ? `已采集即将上线竞品 ${research.upcomingCount} 款` : '⚠️ 即将上线竞品数量未获取到（已记入数据缺口）');

  // 5. 网络情报
  step('正在搜索行业趋势与评测热度…');
  const webQueries = [`${brief.genre} Steam 游戏 2026 趋势 爆款`, `${brief.genre} 独立游戏 市场分析 立项`];
  for (const q of webQueries) {
    if (overBudget()) break;
    try {
      const r = await bingSearch(q, 5);
      research.articles.push(...r.results);
      emit({ type: 'tool', name: 'web_search', status: 'end', summary: `${r.results.length} 条结果` });
    } catch (e) { emit({ type: 'tool', name: 'web_search', status: 'error', summary: truncate(e.message, 150) }); }
  }
  try {
    const v = await searchVideos(`${brief.genre} 游戏 评测 案例`, 6);
    research.videos = v.videos;
  } catch {}

  // 6. 知识库历史结论
  try {
    research.kb = search(`${brief.genre} 立项 市场`, { limit: 5 });
    research.kbInsight = (research.kb.find((k) => k.category !== '项目评估') ?? research.kb[0])?.content ?? null;
  } catch {}

  // 7. 数据就绪度自检：汇总采集结果，缺数据时明确告知（评分引擎按中性分处理并在报告里标注缺口）
  const readiness = [];
  readiness.push(research.competitors.length ? `竞品 ${research.competitors.length} 款` : '⚠️ 无竞品数据');
  readiness.push(releaseRows.length ? `新游记录 ${releaseRows.length} 条` : '⚠️ 无新游数据');
  readiness.push(research.upcomingCount != null ? `即将上线 ${research.upcomingCount} 款` : '⚠️ 即将上线缺失');
  if (research.articles.length) readiness.push(`行业情报 ${research.articles.length} 条`);
  if (research.videos.length) readiness.push(`B站评测 ${research.videos.length} 条`);
  if (research.kb.length) readiness.push(`知识库 ${research.kb.length} 条`);
  if (research.dataSource) readiness.push(`补充数据源 ${research.dataSource}`);
  const weak = research.competitors.length < 3 || !releaseRows.length || research.upcomingCount == null;
  if (skipped) step(`⏱️ 有 ${skipped} 个数据环节因超时被跳过，本次评分置信度降低（报告会标注缺口）`);
  step(`数据采集完成：${readiness.join(' ｜ ')}${weak ? ' ——部分数据缺失，本次评分置信度降低（报告「数据缺口说明」会标注）' : '（数据就绪）'}`);
  research.readiness = { competitors: research.competitors.length, releases: releaseRows.length, upcoming: research.upcomingCount, articles: research.articles.length, videos: research.videos.length, kb: research.kb.length, dataSource: research.dataSource, weak };
  return research;
}

async function narrate(brief, evalResult, research, emit) {
  if (!llmConfigured()) {
    const note = '\n\n---\n> ⚠️ 未配置 LLM（.env 中设置 DEEPSEEK_API_KEY 后重启），以上为离线评分引擎结果，暂无深度解读。';
    emit({ type: 'delta', text: note });
    return evalResult.report + note;
  }
  const compact = {
    brief: { name: brief.name, genre: brief.genre, teamSize: brief.teamSize, experience: brief.experience },
    scores: { total: evalResult.market.total, letter: evalResult.market.letter, completeness: evalResult.market.completeness, dims: evalResult.market.dims.map((d) => ({ n: d.name, s: d.score, st: d.status, detail: d.detail, gaps: d.gaps })) },
    dev: evalResult.dev.months,
    window: { rating: evalResult.window.rating, len: evalResult.window.windowLenMonths, launch: evalResult.window.launchDate, upcoming: evalResult.window.upcomingCount },
    research: {
      releasesByYear: research.releasesByYear,
      competitors: research.competitors.slice(0, 6),
      articles: research.articles.slice(0, 4).map((a) => ({ t: a.title, u: a.url })),
      videos: research.videos.slice(0, 4).map((v) => ({ t: v.title, play: v.play, bvid: v.bvid })),
      kb: research.kb.slice(0, 3).map((k) => k.content),
    },
  };
  const sys = `${SYSTEM_PROMPT}\n\n【任务】你刚完成了一次立项评估。请基于评估数据撰写「专家解读与建议」章节（300-600字，Markdown），要求：1) 点出评分中最值得注意的维度与依据；2) 结合竞品数据与趋势判断该品类当前所处阶段；3) 明确建议走哪条路线与原因；4) 指出最大的 2-3 个风险与对冲方式；5) 若某些维度标注为 no-data/partial（数据缺口），要明确告诉用户哪些结论因此置信度低；6) 保持"概率+情景"的口吻，不夸大确定性。直接输出该章节内容，不要重复上面的表格。`;
  const msgs = [
    { role: 'system', content: sys },
    { role: 'user', content: `评估数据：\n${JSON.stringify(compact)}\n\n用户原始描述：${brief.description}` },
  ];
  const r = await chat({
    messages: msgs,
    temperature: 0.5,
    onDelta: (d) => emit({ type: 'delta', text: d }),
    onReasoning: (t) => emit({ type: 'reasoning', text: t }),
  });
  return r.content;
}

function buildClarify(brief, titles, notFound) {
  const lines = [];
  lines.push('## 需要先确认一下（避免把品类判断错）');
  if (titles.length) {
    lines.push(`我在 Steam 上**没能确认** ${titles.map((t) => `《${t}》`).join('、')} 这款游戏。新上线的游戏很容易被误判成某个"品类"（比如把名字误读成幸存者like），所以先跟你核对。`);
  } else {
    lines.push('你的描述里我**没识别出明确的品类**。为了拉到正确的赛道数据，先跟你核对。');
  }
  lines.push('');
  lines.push('**① 这款游戏的品类是？**（直接回复品类名即可，可带团队/周期）');
  lines.push('');
  lines.push('`肉鸽卡牌` ｜ `幸存者like` ｜ `模拟经营` ｜ `2D 平台跳跃` ｜ `放置挂机` ｜ `塔防` ｜ `沙盒物理` ｜ `视觉小说` ｜ `3D 动作` ｜ `解谜`');
  if (notFound.length) {
    const cands = [...new Set(notFound.flatMap((x) => x.candidates ?? []))].slice(0, 3);
    if (cands.length) {
      lines.push('');
      lines.push('**② 如果它已经在 Steam 上，是不是下面某一款？**（回复准确名字，我再查一次）');
      lines.push(cands.map((c, i) => `- ${c}`).join('\n'));
    }
  }
  lines.push('');
  lines.push('> 补一句就够，例如：「品类：肉鸽卡牌，2D，2人团队，计划12个月上线」——我会立刻跑完整评估。');
  return {
    text: lines.join('\n'),
    suggestions: [
      { type: 'message', label: '🏷️ 肉鸽卡牌', text: '品类：肉鸽卡牌' },
      { type: 'message', label: '🏷️ 幸存者like', text: '品类：幸存者like' },
      { type: 'message', label: '🏷️ 模拟经营', text: '品类：模拟经营' },
      { type: 'message', label: '🏷️ 2D 平台跳跃', text: '品类：2D 平台跳跃' },
    ],
  };
}

async function runEvalMode(briefText, emit, session, context = '') {
  // 阶段横幅：让用户始终知道进度
  emit({ type: 'phase', index: 1, total: 4, text: '理解项目描述' });
  emit({ type: 'status', text: '正在理解项目描述…' });
  const brief = await parseBrief(briefText, context);

  // 预检：文本里提到的具体游戏名，先去 Steam 核对（避免把新游名误当成品类）
  const titles = extractGameTitles(briefText);
  let gameHit = null;
  const notFound = [];
  for (const t of titles) {
    const look = await lookupSteamGame(t, emit);
    if (look?.found) { gameHit = look; break; }
    if (look && !look.found) notFound.push({ query: t, candidates: look.candidates ?? [] });
  }
  if (gameHit) {
    brief.name = gameHit.name;
    if (gameHit.genreTags.length) brief.genre = gameHit.genreTags.slice(0, 3).join(' / ');
    if (!brief.description || brief.description.length < 20) brief.description = gameHit.shortDescription || brief.description;
    brief.game = { appid: gameHit.appid, tags: gameHit.tags.slice(0, 8), price: gameHit.price, reviews: gameHit.reviews, positivePct: gameHit.positivePct, releaseDate: gameHit.releaseDate };
  } else {
    const hasTitleLikeName = titles.length > 0;
    const genreMissing = !brief.genre || brief.genre.trim().length < 2;
    if (genreMissing || hasTitleLikeName) {
      const q = buildClarify(brief, titles, notFound);
      emit({ type: 'delta', text: q.text });
      return { text: q.text, clarify: true, suggestions: q.suggestions, brief };
    }
  }
  emit({ type: 'status', text: `已识别：品类「${brief.genre}」｜团队 ${brief.teamSize} 人（${brief.experience}）${gameHit ? `｜已在 Steam 核对：appid ${gameHit.appid}` : ''}` });

  emit({ type: 'phase', index: 2, total: 4, text: '采集 Steam 市场数据（品类新游/热销竞品/即将上线/行业趋势）' });
  const research = await researchMarket(brief, emit);

  emit({ type: 'phase', index: 3, total: 4, text: '计算市场潜力评分与上线窗口' });
  emit({ type: 'status', text: '正在计算市场潜力评分与上线窗口…' });
  const evalResult = runEvaluation({ ...brief, market: { ...research, genre: brief.genre, description: brief.description } });

  // 持久化：项目档案 + 评估记录（关联当前会话，便于从项目档案回看对话）
  try {
    const slug = (brief.name || 'project').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || `p${Date.now()}`;
    upsertProject({ slug, name: brief.name, description: brief.description, genre: brief.genre, status: '已评估' });
    addEvaluation({ projectSlug: slug, version: 1, scores: evalResult.market, devTime: evalResult.dev, window: evalResult.window, report: evalResult.report, meta: { brief, session } });
    addInsight({
      content: `项目《${brief.name}》评估：市场潜力 ${evalResult.market.total}/100（${evalResult.market.letter}），窗口 ${evalResult.window.rating}，基准工期 ${evalResult.dev.months.expected} 个月`,
      category: '项目评估',
      tags: `${brief.genre},立项评估`,
      sourceType: 'evaluation', sourceRef: slug,
      weight: 0.6,
    });
    invalidate();
  } catch (e) { emit({ type: 'status', text: `（评估档案保存失败: ${e.message}）` }); }

  // 先推送结构化评分与核心报告，再流式输出专家解读
  emit({
    type: 'scores',
    data: {
      total: evalResult.market.total,
      letter: evalResult.market.letter,
      window: evalResult.window.rating,
      devExpected: evalResult.dev.months.expected,
      devRange: [evalResult.dev.months.optimistic, evalResult.dev.months.pessimistic],
      completeness: evalResult.market.completeness,
      collected: research.readiness ?? null,
      dataSource: research.dataSource ?? null,
    },
  });
  emit({ type: 'report', text: evalResult.report });
  emit({ type: 'phase', index: 4, total: 4, text: '生成评估报告与专家解读' });
  emit({ type: 'status', text: '正在撰写专家解读…' });
  const narration = await narrate(brief, evalResult, research, emit);

  const finalReport = `${evalResult.report}\n\n## 🎙 专家解读与建议\n\n${narration}`;
  // 沉淀结论
  distillFromText(`${brief.genre} 评估：市场 ${evalResult.market.total} 分(${evalResult.market.letter})，窗口 ${evalResult.window.rating}，基准工期 ${evalResult.dev.months.expected} 月。竞品 ${research.competitors.length} 款，${research.releasesByYear[curYearKey()] ?? '?'}`, { category: '调研结论', tags: `${brief.genre},评估`, silent: true }).catch(() => {});
  return { text: finalReport, projectName: brief.name, genre: brief.genre };
}

function curYearKey() { return String(new Date().getFullYear()); }

// ---------- 学习沉淀 ----------
export async function distillFromText(text, { category = '调研结论', tags = '', sourceType = null, sourceRef = null, url = null, maxInsights = 4, silent = false, skipDedupe = false } = {}) {
  if (!llmConfigured() || !text || text.length < 60) return [];
  const sys = `你是知识提炼助手。从文本中提炼对 Steam 游戏市场调研有长期价值的结论/数据点/方法论（含关键数字与日期），输出 JSON 数组：[{"content":"结论(60字内)","tags":"逗号分隔中文标签"}]。最多 ${maxInsights} 条，宁缺毋滥，只输出 JSON。`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: truncate(text, 5000) }], temperature: 0 });
      const arr = parseJsonLoose(r.content);
      const out = [];
      for (const it of (Array.isArray(arr) ? arr : []).slice(0, maxInsights)) {
        if (!it?.content) continue;
        // 去重：与库内最相似条目比较（相似度过高则跳过）；升级提炼场景可跳过（与原始条目同源）
        if (!skipDedupe) {
          const dup = search(it.content, { limit: 1 });
          if (dup.length && dup[0].score > 2.2) continue;
        }
        const id = addInsight({ content: truncate(it.content, 300), category, tags: it.tags || tags, sourceType, sourceRef, url, weight: 1.1 });
        out.push(id);
        invalidate();
      }
      if (out.length) {
        if (!silent) setMeta('last_distill', new Date().toISOString());
        return out;
      }
      if (attempt === 0) await sleep(2500); // 解析为空：重试一次
    } catch (e) {
      if (attempt === 0) { await sleep(2500); continue; } // 请求失败：重试一次
      if (!silent) console.error('[distill] 提炼失败:', e.message);
      return [];
    }
  }
  return [];
}

// ---------- 对外主入口 ----------
export async function runChat({ session = 'default', message, mode = null, emit = () => {} }) {
  const history = recentConvs(session, CONFIG.agent.historyTurns * 2);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history) messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
  messages.push({ role: 'user', content: message });

  // 上下文（供追问/补充信息时理解指代）
  const context = history.slice(-6).map((h) => `${h.role === 'user' ? '用户' : '助手'}：${truncate(h.content, 160)}`).join('\n');
  // 如果上一轮是"需要确认品类"的提问，本轮回复按评估续跑处理
  const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant');
  const lastMeta = safeJsonParse(lastAssistant?.meta ?? '{}', {});

  addConv(session, 'user', message);
  const m = mode ?? (lastMeta.clarify ? 'eval' : detectMode(message));

  let finalText;
  let evalMeta = null;
  try {
    if (m === 'eval') {
      evalMeta = await runEvalMode(message, emit, session, context);
      finalText = evalMeta.text;
    } else {
      emit({ type: 'status', text: llmConfigured() ? '正在思考（可调用 Steam/B站/搜索/知识库工具）…' : 'LLM 未配置，只能走离线模式…' });
      if (!llmConfigured()) {
        const text = `⚠️ 尚未配置 LLM（DeepSeek API Key）。\n\n请编辑项目根目录 \`.env\` 文件（参考 \`.env.example\`），填入 \`DEEPSEEK_API_KEY\` 后重启服务，即可使用完整的对话调研能力。\n\n当前可用：\n- 离线立项评估：直接描述你的项目（会触发数据采集 + 评分引擎）；\n- 本地知识库：${counts().insights} 条洞察、${counts().sources} 条原始来源。`;
        emit({ type: 'delta', text });
        finalText = text;
      } else {
        finalText = await reactLoop(messages, emit, { session });
        if (!finalText) finalText = '（本轮未产出内容，请换个问法）';
      }
    }
  } catch (e) {
    const msg = e instanceof LLMError ? e.message : `处理出错: ${e.message}`;
    emit({ type: 'error', message: msg });
    addConv(session, 'assistant', `[错误] ${msg}`, { error: true });
    throw e;
  }

  const suggestions = evalMeta?.clarify
    ? (evalMeta.suggestions ?? [])
    : buildSuggestions(m, { projectName: evalMeta?.projectName, genre: evalMeta?.genre, userMessage: message });
  const convId = addConv(session, 'assistant', finalText, {
    mode: m,
    kb: counts().insights,
    suggestions,
    clarify: Boolean(evalMeta?.clarify),
  });
  emit({ type: 'done', convId, suggestions });
  // 异步沉淀本轮结论（不阻塞响应）
  if (llmConfigured() && finalText.length > 300 && m !== 'eval') {
    distillFromText(`用户问题: ${message}\n\n分析结论: ${finalText}`, { category: '调研结论', sourceType: 'conversation', sourceRef: String(convId), silent: true }).catch(() => {});
  }
  return finalText;
}

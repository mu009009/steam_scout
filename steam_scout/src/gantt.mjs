// Demo/里程碑「周级甘特图」排期引擎（确定性计算，不依赖 LLM）
//
// 输入：项目画像（品类/团队/目标状态/内容体量/已完成/截止或档期）
// 输出：周级排期表（按角色分列）、关键 Gate 与通过标准、装不下的三种取舍方案，
//       以及一份可直接打印成 A4 横向 PDF 的 HTML。
//
// 设计原则：
// 1) 先"能不能装进档期"，再谈细节——装不下就明确给出砍内容/加人/推迟三选一，绝不硬塞；
// 2) 每个任务的估算是人日，按角色产能分配到周，依赖关系决定先后（原型→系统冻结→内容→打磨→冻结）；
// 3) 末尾固定留缓冲周，且声明"缓冲不是可用的时间"。

const DAYS_PER_WEEK = 5;
const FOCUS = 0.8; // 专注系数：会议/沟通/返工吃掉 20%

/** 品类复杂度系数：影响原型与系统实现工时 */
const GENRE_FACTOR = [
  { re: /卡牌|构筑|deck|tcg|rogue|肉鸽|幸存者|割草|自走棋/i, f: 1.25, label: '系统复杂型（卡牌/构筑/肉鸽）' },
  { re: /模拟经营|经营|管理|建造|沙盒|策略|4x|塔防/i, f: 1.2, label: '系统+内容双线型（模拟经营/策略）' },
  { re: /rpg|角色扮演|剧情|叙事|视觉小说|avg|galgame/i, f: 1.15, label: '内容驱动型（叙事/RPG）' },
  { re: /平台|跳跃|动作|射击|格斗|跑酷/i, f: 1.0, label: '动作手感型（平台/动作）' },
  { re: /解谜|休闲|放置|挂机|音游|节奏/i, f: 0.85, label: '轻量型（解谜/休闲/放置）' },
];

export function genreFactor(genre = '', description = '') {
  const hay = `${genre} ${description}`;
  for (const g of GENRE_FACTOR) if (g.re.test(hay)) return g;
  return { f: 1.1, label: '通用' };
}

/** 把团队人数拆成角色（保守假设：3 人 = 1 程序 + 1 策划 + 1 美术；人少则角色合并） */
export function deriveRoles(teamSize = 3, roles = null) {
  if (roles && (roles.program || roles.design || roles.art)) {
    return {
      program: Math.max(0, Number(roles.program) || 0),
      design: Math.max(0, Number(roles.design) || 0),
      art: Math.max(0, Number(roles.art) || 0),
    };
  }
  const n = Math.max(1, Number(teamSize) || 1);
  if (n === 1) return { program: 1, design: 0, art: 0, solo: true };
  if (n === 2) return { program: 1, design: 1, art: 0 };
  if (n === 3) return { program: 1, design: 1, art: 1 };
  const rest = n - 3;
  return { program: 1 + Math.ceil(rest / 2), design: 1, art: 1 + Math.floor(rest / 2) };
}

/** 内容体量归一化 */
export function normalizeScope(scope = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const chapters = num(scope.chapters, 1);
  const cards = num(scope.cards, 0);
  const bosses = num(scope.bosses, 0);
  const levels = num(scope.levels, 0);
  const characters = num(scope.characters, 0);
  const words = num(scope.words, chapters * 20000); // 剧情字数（叙事向）
  return { chapters, cards, bosses, levels, characters, words };
}

/** 任务模板：每个任务 = { id, phase, role, personDays, deps } */
export function buildTasks(brief = {}) {
  const gf = genreFactor(brief.genre, brief.description);
  const scope = normalizeScope(brief.scope);
  const milestone = brief.milestone || 'Demo';
  const narration = /剧情|叙事|rpg|视觉小说|avg/i.test(`${brief.genre} ${brief.description}`);
  const tasks = [];
  const add = (t) => tasks.push(t);

  const f = gf.f;
  // —— P0 立项与规格 ——
  add({ id: 'spec', phase: 'P0', role: 'design', name: '玩法与内容规格书（一页纸口径）', personDays: 4, deps: [], gate: null });
  add({ id: 'pipeline', phase: 'P0', role: 'program', name: '工程脚手架 / 资产管线 / 构建出包', personDays: 5 * f, deps: [] });

  // —— P1 核心循环原型（垂直切片）——
  add({ id: 'core', phase: 'P1', role: 'program', name: '核心循环可玩原型（含手感/反馈）', personDays: 18 * f, deps: ['pipeline'], gate: null });
  add({ id: 'proto-art', phase: 'P1', role: 'art', name: '原型期占位美术与 UI 草图', personDays: 10, deps: [] });
  if (scope.cards > 0) add({ id: 'art-pilot', phase: 'P1', role: 'art', name: '美术风格定样（先做 6–10 张，确认风格与产能）', personDays: 8, deps: ['proto-art'] });
  add({ id: 'bal-v0', phase: 'P1', role: 'design', name: '数值规格 v0.1 与关卡节奏草案', personDays: 6, deps: ['spec'] });
  add({ id: 'playtest1', phase: 'P1', role: 'design', name: '内部 20 局 + 5 名陌生玩家测试', personDays: 6, deps: ['core', 'bal-v0'], gate: 'G1' });

  // —— P2 系统实现与冻结 ——
  add({ id: 'systems', phase: 'P2', role: 'program', name: '正式系统实现（存档/设置/本地化框架）', personDays: 14 * f, deps: ['playtest1'] });
  add({ id: 'sys-freeze', phase: 'P2', role: 'program', name: '按测试反馈返工 + 系统冻结', personDays: 10 * f, deps: ['systems', 'playtest1'], gate: 'G2' });

  // —— 商店页与宣发（P2 起并行，越早越好）——
  add({ id: 'store', phase: 'P2', role: 'marketing', name: 'Steam 商店页上线（含首图/简介/标签）', personDays: 5, deps: ['proto-art'] });
  add({ id: 'trailer', phase: 'P3', role: 'marketing', name: '首支 15 秒预告 + 社媒节奏建立', personDays: 6, deps: ['store', 'sys-freeze'] });

  // —— P3 内容生产（全部排在系统冻结之后，避免返工）——
  if (scope.chapters > 0 && narration) {
    // 中文分支剧情含分场/演出接线的实际产能约 2000 字/人日
    add({ id: 'story', phase: 'P3', role: 'design', name: `${scope.chapters} 章剧情脚本（约 ${Math.round(scope.words / 10000)} 万字）`, personDays: Math.max(10, Math.round(scope.words / 2000)), deps: ['sys-freeze'] });
  }
  if (scope.levels > 0) {
    add({ id: 'levels', phase: 'P3', role: 'design', name: `${scope.levels} 个关卡/场景设计与摆放`, personDays: 4 * scope.levels, deps: ['sys-freeze'] });
  }
  if (scope.bosses > 0) {
    add({ id: 'bosses', phase: 'P3', role: 'program', name: `${scope.bosses} 个 Boss 战实现与 AI`, personDays: 8 * scope.bosses * f, deps: ['sys-freeze'] });
  }
  if (scope.cards > 0) {
    add({ id: 'cards-sys', phase: 'P3', role: 'program', name: `${scope.cards} 张卡牌的机制、配置与平衡`, personDays: Math.max(6, scope.cards * 0.3 * f), deps: ['sys-freeze'] });
    // 批量卡面必须等系统冻结之后再排，否则系统一改就全部返工（早期只做定样）
    add({ id: 'cards-art', phase: 'P3', role: 'art', name: `${scope.cards} 张卡面美术（批量排产）`, personDays: Math.max(8, scope.cards * 0.35), deps: ['sys-freeze', 'art-pilot'] });
  }
  if (scope.characters > 0) {
    add({ id: 'chars-art', phase: 'P3', role: 'art', name: `${scope.characters} 个角色立绘 + 表情差分`, personDays: 6 * scope.characters, deps: ['sys-freeze', 'art-pilot'] });
  }
  add({ id: 'content-freeze', phase: 'P3', role: 'design', name: '全流程走查 + 内容冻结', personDays: 8, deps: tasks.filter((t) => t.phase === 'P3').map((t) => t.id), gate: 'G3' });

  // —— P4 打磨 ——
  add({ id: 'ui', phase: 'P4', role: 'art', name: 'UI/UX 重构与信息可读性', personDays: 15, deps: ['content-freeze'] });
  add({ id: 'audio', phase: 'P4', role: 'program', name: '音效/音乐接入', personDays: 6, deps: ['content-freeze'] });
  add({ id: 'polish', phase: 'P4', role: 'program', name: '性能/稳定性/引导（前 10 分钟）', personDays: 10, deps: ['ui'] });
  add({ id: 'playtest2', phase: 'P4', role: 'design', name: '外部 playtest（30 人+）与问卷', personDays: 8, deps: ['polish'] });

  // —— P5 冻结与缓冲 ——
  add({ id: 'bugfix', phase: 'P5', role: 'program', name: '致命 bug 清零 + build 准备', personDays: 10, deps: ['playtest2'], gate: 'G4' });
  add({ id: 'buffer', phase: 'P5', role: 'program', name: '缓冲周（只修不增）', personDays: 10, deps: ['bugfix'] });
  return { tasks, genreLabel: gf.label, factor: f, scope, milestone, narration };
}

/** 贪心排期：按依赖顺序把任务落到具体周，返回 { tasks(含 startWeek/endWeek), totalWeeks, workload } */
export function scheduleTasks(tasks, roles, { daysPerWeek = DAYS_PER_WEEK, focus = FOCUS, partTimeRatio = 1 } = {}) {
  const capacity = {}; // role -> personDays per week
  for (const [role, n] of Object.entries(roles)) capacity[role] = n * daysPerWeek * focus * partTimeRatio;
  // 单人团队：所有角色合并到 program
  if (roles.solo) { capacity.program = (roles.program || 1) * daysPerWeek * focus * partTimeRatio; }

  const weekFree = {}; // role -> 当前可用的最早周
  for (const role of ['program', 'design', 'art', 'marketing']) weekFree[role] = 1;

  const order = [...tasks];
  const byId = new Map();
  let maxWeek = 1;
  for (const t of order) {
    const role = t.role === 'marketing' ? 'marketing' : t.role;
    const depEnd = Math.max(0, ...t.deps.map((d) => byId.get(d)?.endWeek ?? 0));
    const cap = Math.max(1, capacity[role] || (roles.solo ? capacity.program : 5 * focus));
    const start = Math.max(depEnd + 1, weekFree[role] || 1);
    const span = Math.max(1, Math.ceil(t.personDays / cap - 1e-9));
    const endWeek = start + span - 1;
    const rec = { ...t, startWeek: start, endWeek, weeks: span };
    byId.set(t.id, rec);
    weekFree[role] = endWeek + 1;
    maxWeek = Math.max(maxWeek, endWeek);
  }
  const scheduled = [...byId.values()].sort((a, b) => a.startWeek - b.startWeek || a.role.localeCompare(b.role));
  const totalPersonDays = tasks.reduce((s, t) => s + t.personDays, 0);
  return { tasks: scheduled, totalWeeks: maxWeek, totalPersonDays, capacity };
}

/** 新品节反向档期（媒体预览线 -5 周、build 冻结 -3 周，依据知识库规律） */
export function reverseFestWindow(openDateISO) {
  const d = new Date(openDateISO);
  if (Number.isNaN(d.getTime())) return null;
  const shift = (weeks) => {
    const x = new Date(d.getTime() - weeks * 7 * 86400000);
    return x.toISOString().slice(0, 10);
  };
  return { open: d.toISOString().slice(0, 10), media: shift(5), freeze: shift(3) };
}

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d;
}
function fmtMD(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
}
function weekStartDate(startISO, weekIndex) {
  return addDays(startISO, (weekIndex - 1) * 7);
}

const ROLE_LABEL = { program: '程序', design: '策划/剧情', art: '美术', marketing: '商店页·宣发' };
const PHASE_LABEL = { P0: '准备', P1: '原型', P2: '系统', P3: '内容', P4: '打磨', P5: '冻结' };

/** 生成完整排期方案（含 markdown 与结构化数据） */
export function buildGantt(brief = {}) {
  const roles = deriveRoles(brief.teamSize, brief.roles);
  const { tasks, genreLabel, factor, scope, milestone, narration } = buildTasks(brief);
  const partTimeRatio = brief.partTime === true || brief.hoursPerWeek === 'part' ? 0.55 : 1;
  const startISO = brief.startDate && !Number.isNaN(new Date(brief.startDate).getTime())
    ? new Date(brief.startDate).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const plan = scheduleTasks(tasks, roles, { partTimeRatio });

  // 档期对比
  let festInfo = null;
  let deadlineISO = brief.deadline && !Number.isNaN(new Date(brief.deadline).getTime()) ? new Date(brief.deadline).toISOString().slice(0, 10) : null;
  if (brief.festOpen) {
    festInfo = reverseFestWindow(brief.festOpen);
    if (festInfo) deadlineISO = deadlineISO || festInfo.freeze; // 以 build 冻结为硬截止
  }
  const finishDate = addDays(startISO, plan.totalWeeks * 7 - 1);
  const availableWeeks = deadlineISO
    ? Math.floor((new Date(deadlineISO) - new Date(startISO)) / (7 * 86400000))
    : null;
  const fit = availableWeeks == null ? null
    : plan.totalWeeks <= availableWeeks ? 'fits'
      : availableWeeks >= plan.totalWeeks * 0.8 ? 'tight' : 'overflow';

  // 周表（按角色聚合）
  const weekRows = [];
  for (let w = 1; w <= plan.totalWeeks; w++) {
    const cell = { program: [], design: [], art: [], marketing: [], gates: [] };
    for (const t of plan.tasks) {
      if (w >= t.startWeek && w <= t.endWeek) {
        if (t.role === 'marketing') cell.marketing.push(t.name);
        else cell[t.role]?.push(t.name);
      }
      if (t.gate && w === t.endWeek) {
        const gateName = t.id === 'playtest1' ? 'G1 go/no-go'
          : t.id === 'sys-freeze' ? 'G2 系统冻结'
            : t.id === 'content-freeze' ? 'G3 内容冻结'
              : t.id === 'bugfix' ? 'G4 build 冻结' : t.gate;
        cell.gates.push(gateName);
      }
    }
    const ws = weekStartDate(startISO, w);
    weekRows.push({
      week: `W${w}`,
      range: `${fmtMD(ws)}–${fmtMD(addDays(ws, 6))}`,
      program: cell.program, design: cell.design, art: cell.art, marketing: cell.marketing, gates: cell.gates,
    });
  }
  // 档期节点插入
  if (festInfo) {
    const mediaWeek = Math.max(1, Math.floor((new Date(festInfo.media) - new Date(startISO)) / (7 * 86400000)) + 1);
    const freezeWeek = Math.max(1, Math.floor((new Date(festInfo.freeze) - new Date(startISO)) / (7 * 86400000)) + 1);
    if (weekRows[mediaWeek - 1] && mediaWeek <= plan.totalWeeks) weekRows[mediaWeek - 1].gates.push(`◆ 媒体预览线 ${festInfo.media}`);
    if (weekRows[freezeWeek - 1] && freezeWeek <= plan.totalWeeks) weekRows[freezeWeek - 1].gates.push(`◆ build 冻结 ${festInfo.freeze}`);
  }

  const data = {
    name: brief.name || '未命名项目',
    genre: brief.genre || '',
    milestone,
    startISO,
    finishDate: finishDate.toISOString().slice(0, 10),
    deadlineISO,
    fest: festInfo,
    availableWeeks,
    totalWeeks: plan.totalWeeks,
    totalPersonDays: Math.round(plan.totalPersonDays),
    personMonths: +(plan.totalPersonDays / 21.7).toFixed(1),
    roles,
    partTime: partTimeRatio < 1,
    fit,
    genreLabel,
    factor,
    scope,
    weeks: weekRows,
    tasks: plan.tasks.map((t) => ({ name: t.name, role: t.role, phase: t.phase, startWeek: t.startWeek, endWeek: t.endWeek, personDays: Math.round(t.personDays), gate: t.gate })),
    targetState: brief.targetState || '',
    done: brief.done || [],
  };

  // 装不下时：迭代收紧范围，找出"最小能装下"的具体口径（而不是只说一句"砍内容"）
  if (fit === 'overflow' && availableWeeks) {
    let best = null;
    for (const ratio of [0.85, 0.7, 0.55, 0.4, 0.3, 0.2]) {
      const sc = {
        chapters: Math.max(1, Math.round(scope.chapters * ratio)) || 1,
        cards: scope.cards ? Math.max(20, Math.round((scope.cards * ratio) / 10) * 10) : 0,
        bosses: scope.bosses ? Math.max(1, Math.round(scope.bosses * ratio)) : 0,
        levels: scope.levels ? Math.max(2, Math.round(scope.levels * ratio)) : 0,
        characters: scope.characters ? Math.max(1, Math.round(scope.characters * ratio)) : 0,
        words: Math.max(3000, Math.round(scope.words * ratio)),
      };
      const t2 = buildTasks({ ...brief, scope: sc });
      const p2 = scheduleTasks(t2.tasks, roles, { partTimeRatio });
      const rec = { scope: sc, totalWeeks: p2.totalWeeks, personMonths: +(p2.totalPersonDays / 21.7).toFixed(1), totalPersonDays: Math.round(p2.totalPersonDays) };
      if (!best || rec.totalWeeks < best.totalWeeks) best = rec;
      if (p2.totalWeeks <= availableWeeks) { best = rec; best.fits = true; break; }
    }
    if (best) {
      best.fits = best.fits ?? best.totalWeeks <= availableWeeks;
      best.savedPersonMonths = +(data.personMonths - best.personMonths).toFixed(1);
      data.trim = best;
    }
    // 保持原范围所需的额外产能（人月）
    data.extraPersonMonthsToKeepScope = +(plan.totalPersonDays * (plan.totalWeeks / availableWeeks - 1) / 21.7).toFixed(1);
  }

  data.markdown = renderPlanMarkdown(data, brief);
  data.html = renderPlanHtml(data, brief);
  return data;
}

function roleText(list) {
  return list.length ? list.join('；') : '—';
}

/** markdown 版（聊天里直接看，也能走通用 PDF 导出） */
function renderPlanMarkdown(d, brief) {
  const L = [];
  const team = Object.entries(d.roles).filter(([k]) => k !== 'solo').map(([k, v]) => `${ROLE_LABEL[k] || k} ${v}`).join(' / ');
  L.push(`# 《${d.name}》${d.milestone} 周级甘特图`);
  L.push('');
  L.push(`> 起点 **${d.startISO}** ｜ 周期 **${d.totalWeeks} 周**（约 ${(d.totalWeeks / 4.35).toFixed(1)} 个月）｜ 完成 **${d.finishDate}** ｜ 总工作量 **${d.totalPersonDays} 人日（约 ${d.personMonths} 人月）** ｜ 团队：${team}${d.partTime ? '｜**兼职投入（产能按 55% 计）**' : ''}`);
  if (d.targetState) L.push(`> 阶段目标：${d.targetState}`);
  if (d.deadlineISO) {
    const verdict = d.fit === 'fits' ? '✅ 装得下' : d.fit === 'tight' ? '⚠️ 偏紧（余量不足 20%）' : '❌ 装不下';
    L.push(`> 硬截止 **${d.deadlineISO}**（可用 ${d.availableWeeks} 周）：**${verdict}**`);
  } else {
    L.push('> 未设硬截止：按最快路径排期（如需对齐档期，回一句「对标 2027 年 6 月新品节」我重排）');
  }
  L.push(`> 估算口径：品类「${d.genreLabel}」复杂度系数 ${d.factor}；按每周 5 天、专注系数 0.8 折算；含 ${Math.round(d.totalPersonDays * 0.15)} 人日左右的返工与打磨已内含。`);
  if (brief.assumptions && brief.assumptions.length) {
    L.push(`> 本次按**默认假设**排（可在下一条消息里改）：${brief.assumptions.join('；')}`);
  }
  L.push('');

  if (d.fit === 'overflow') {
    L.push('## 0. 先说结论：这个范围装不进档期');
    const gap = d.totalWeeks - d.availableWeeks;
    L.push(`按当前内容体量需要 **${d.totalWeeks} 周**，可用只有 **${d.availableWeeks} 周**，**差 ${gap} 周**。三条路，只能选一条，别想着"加加班挤一挤"：`);
    L.push('');
    L.push('| 方案 | 具体做法 | 结果 | 代价 |');
    L.push('|---|---|---|---|');
    const trim = d.trim;
    const trimScope = trim
      ? [trim.scope.chapters ? `${trim.scope.chapters} 章` : null, trim.scope.cards ? `${trim.scope.cards} 张卡` : null, trim.scope.bosses ? `${trim.scope.bosses} 个 Boss` : null, trim.scope.levels ? `${trim.scope.levels} 个关卡` : null].filter(Boolean).join(' / ')
      : '';
    L.push(`| **A 砍内容**（推荐） | 收到 ${trimScope} | **约 ${trim ? trim.totalWeeks : '?'} 周 / ${trim ? trim.personMonths : '?'} 人月**${trim && trim.fits ? '，✅ 赶上档期' : '，⚠️ 仍偏紧'} | 内容厚度下降，宣发卖点变窄（但机制能讲清楚） |`);
    L.push(`| B 加人 / 转全职 | 保持原范围需多出约 **${d.extraPersonMonthsToKeepScope ?? '?'} 人月**产能 | 约 ${d.availableWeeks} 周 | 协作与返工成本上升，新人上手期本身要吃 2–4 周 |`);
    L.push(`| C 推迟档期 | 推到下一个窗口（通常 +4~5 个月） | 完整交付 | 错过当季流量，愿望单积累期拉长 |`);
    L.push('');
    L.push('> 小团队的经验法则：**砍内容 > 推迟档期 > 加人**。加人是唯一一个"越加越慢"的选项——尤其在你还没有清晰规格的时候。');
    L.push('> 下面的甘特图是**原始范围**的排期（用于看清真实工作量）；选定方案后告诉我新范围，我按新口径重排。');
    L.push('');
  } else if (d.fit === 'tight') {
    L.push('## 0. 风险提示：档期偏紧');
    L.push(`需要 **${d.totalWeeks} 周**，可用 **${d.availableWeeks} 周**，余量只有 **${d.availableWeeks - d.totalWeeks} 周**（不足 20%）。这意味着：任何一处超时都没有缓冲可吃，建议提前准备"砍内容"的预案。`);
    L.push('');
  }

  L.push('## 1. 周级排期表');
  L.push('');
  L.push('| 周 | 日期 | 程序 | 策划/剧情 | 美术 | 商店页·宣发 | 决策点 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const w of d.weeks) {
    L.push(`| **${w.week}** | ${w.range} | ${roleText(w.program)} | ${roleText(w.design)} | ${roleText(w.art)} | ${roleText(w.marketing)} | ${w.gates.length ? '**' + w.gates.join('；') + '**' : ''} |`);
  }
  L.push('');

  L.push('## 2. 关键 Gate 与通过标准（不达标就停，不要往下推）');
  L.push('');
  L.push('| Gate | 时间 | 通过标准 |');
  L.push('|---|---|---|');
  const g = (name, week, crit) => L.push(`| **${name}** | W${week} | ${crit} |`);
  const tById = new Map(d.tasks.map((t) => [t.name, t]));
  const endOf = (kw) => (d.tasks.find((t) => t.name.includes(kw))?.endWeek ?? '—');
  g('G1 go/no-go', endOf('陌生玩家'), '① 5 名陌生玩家中 ≥3 人 10 分钟内理解核心循环并在第 3 局主动规划；② 愿意继续玩；③ 不出现"必须拖回合才能赢"');
  g('G2 系统冻结', endOf('系统冻结'), '关键数值问题全部有实测答案（不是估算）；此后只修不增');
  g('G3 内容冻结', endOf('内容冻结'), '全流程可通、无卡死；单周目时长达标；内容缺口清单清零');
  g('G4 build 冻结', endOf('致命 bug'), '可稳定运行 60 分钟以上、致命 bug 为 0、前 10 分钟引导完整');
  if (d.fest) {
    g('档期硬线', Math.max(1, Math.floor((new Date(d.fest.freeze) - new Date(d.startISO)) / (7 * 86400000)) + 1), `媒体预览线 ${d.fest.media}（需可玩 build）｜build 冻结 ${d.fest.freeze}｜开幕 ${d.fest.open}`);
  }
  L.push('');

  L.push('## 3. 三条硬性纪律（这张表能不能落地就看这三条）');
  L.push('');
  L.push('1. **系统冻结前后不要并行开新内容。** 原型阶段就把内容管线铺开，是最常见的白工来源——系统一改，前面画的美术、写的剧情全部返工。');
  L.push(`2. **最后 ${Math.max(1, Math.round(d.totalWeeks * 0.1))} 周是缓冲，不是可用时间。** 进度落后从这里扣，扣完就要立刻决定"砍内容"还是"推迟档期"，不要在最后两周硬赶。`);
  L.push('3. **商店页要早于内容完成上线。** 它是个需要时间积累的数据入口；等内容做完再上，后面的愿望单冲刺就没有起点。');
  L.push('');

  L.push('## 4. 人力与工作量分布');
  L.push('');
  const byRole = {};
  for (const t of d.tasks) byRole[t.role] = (byRole[t.role] || 0) + t.personDays;
  L.push('| 角色 | 工作量（人日） | 占比 |');
  L.push('|---|---|---|');
  for (const [r, v] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) {
    L.push(`| ${ROLE_LABEL[r] || r} | ${Math.round(v)} | ${Math.round((v / d.totalPersonDays) * 100)}% |`);
  }
  L.push('');
  const busiest = [...d.tasks].sort((a, b) => b.personDays - a.personDays).slice(0, 3);
  L.push(`**最重的三个任务**：${busiest.map((t) => `${t.name}（${t.personDays} 人日，W${t.startWeek}–W${t.endWeek}）`).join('；')}`);
  L.push('');
  L.push('## 5. 阶段分解');
  L.push('');
  L.push('| 阶段 | 任务 | 周次 | 人日 |');
  L.push('|---|---|---|---|');
  for (const t of d.tasks) {
    L.push(`| ${PHASE_LABEL[t.phase] || t.phase} | ${t.name} | W${t.startWeek}–W${t.endWeek} | ${t.personDays} |`);
  }
  L.push('');
  if (d.done && d.done.length) {
    L.push(`> 已从排期中剔除的已完成项：${d.done.join('、')}（若实际未完成，请告诉我，我重新排）`);
    L.push('');
  }
  L.push('> 本表由确定性排期引擎生成（人日估算 + 角色产能 + 依赖关系），可直接导入表格软件按周跟踪。**每周更新一次实际进度，偏差超过 1 周就重排。**');
  return L.join('\n');
}

/** 打印版 HTML（A4 横向，甘特条块用色块表现） */
function renderPlanHtml(d, brief) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const COLORS = { program: '#2f6fed', design: '#8b5cf6', art: '#f59e0b', marketing: '#10b981' };
  const roles = ['program', 'design', 'art', 'marketing'];
  const totalWeeks = d.totalWeeks;
  const rows = d.tasks.map((t) => {
    const left = ((t.startWeek - 1) / totalWeeks) * 100;
    const width = Math.max(2, ((t.endWeek - t.startWeek + 1) / totalWeeks) * 100);
    return `<tr>
      <td class="task">${esc(t.name)}</td>
      <td class="role" style="color:${COLORS[t.role] || '#666'}">${esc(ROLE_LABEL[t.role] || t.role)}</td>
      <td class="bar-cell"><div class="bar" style="left:${left}%;width:${width}%;background:${COLORS[t.role] || '#666'}">${t.endWeek - t.startWeek + 1}w</div></td>
      <td class="num">${t.personDays}</td>
    </tr>`;
  }).join('');
  const weekHeader = Array.from({ length: totalWeeks }, (_, i) => {
    const w = d.weeks[i];
    return `<th class="wk${w.gates.length ? ' gate' : ''}">${esc(w.week)}<span>${esc(w.range)}</span></th>`;
  }).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>《${esc(d.name)}》${esc(d.milestone)} 周级甘特图</title>
<style>
  @page { size: A4 landscape; margin: 8mm 6mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei","PingFang SC",sans-serif; color:#111; margin:0; font-size:9pt; line-height:1.45; }
  h1 { font-size:16pt; margin:0 0 3mm; }
  h2 { font-size:11pt; margin:5mm 0 2mm; padding-left:2mm; border-left:3px solid #2f6fed; }
  table { border-collapse:collapse; width:100%; }
  th,td { border:1px solid #bbb; padding:3px 4px; vertical-align:middle; }
  th { background:#eef2f8; font-size:8.5pt; }
  .task { width:30%; }
  .role { width:9%; font-weight:600; }
  .bar-cell { position:relative; width:52%; height:16px; background:repeating-linear-gradient(90deg,#fff 0,#fff 3.57%,#f4f6fa 3.57%,#f4f6fa 7.14%); }
  .bar { position:absolute; top:2px; height:12px; border-radius:2px; color:#fff; font-size:7pt; text-align:center; line-height:12px; opacity:.92; }
  .num { width:5%; text-align:right; }
  .meta { color:#444; font-size:8.5pt; margin-bottom:3mm; }
  .meta b { color:#111; }
  .fits { color:#0a7a34; font-weight:700; }
  .tight { color:#b45309; font-weight:700; }
  .overflow { color:#b91c1c; font-weight:700; }
  .gates { margin-top:4mm; font-size:8.5pt; }
  .gates td { vertical-align:top; }
  .foot { margin-top:5mm; color:#888; font-size:7.5pt; border-top:1px solid #ccc; padding-top:2mm; }
  .wk { font-size:7pt; text-align:center; }
  .wk span { display:block; font-weight:400; color:#666; font-size:6pt; }
  th.gate { background:#ffe9c7; }
</style></head><body>
<h1>《${esc(d.name)}》${esc(d.milestone)} 周级甘特图</h1>
<div class="meta">
  起点 <b>${esc(d.startISO)}</b> ｜ 周期 <b>${d.totalWeeks} 周</b>（约 ${(d.totalWeeks / 4.35).toFixed(1)} 个月）｜ 完成 <b>${esc(d.finishDate)}</b> ｜
  总工作量 <b>${d.totalPersonDays} 人日 ≈ ${d.personMonths} 人月</b> ｜ 团队 ${Object.entries(d.roles).filter(([k]) => k !== 'solo').map(([k, v]) => `${ROLE_LABEL[k] || k} ${v}`).join(' / ')}
  ${d.deadlineISO ? ` ｜ 硬截止 <b>${esc(d.deadlineISO)}</b>（可用 ${d.availableWeeks} 周，<span class="${d.fit}">${d.fit === 'fits' ? '装得下' : d.fit === 'tight' ? '偏紧' : '装不下'}</span>）` : ''}
  ${d.targetState ? `<br>阶段目标：${esc(d.targetState)}` : ''}
</div>

<h2>工作任务甘特图（色块 = 占用周）</h2>
<table>
  <thead><tr><th class="task">任务</th><th class="role">角色</th><th colspan="${Math.min(totalWeeks, 1)}">周次</th><th class="num">人日</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<table class="gates">
  <tr><th>周</th>${weekHeader}</tr>
</table>

<h2>关键 Gate 与通过标准</h2>
<table class="gates">
  <tr><th style="width:14%">Gate</th><th>通过标准</th></tr>
  <tr><td><b>G1 go/no-go</b></td><td>5 名陌生玩家中 ≥3 人 10 分钟内理解核心循环、第 3 局主动规划；不达标就改系统，不要靠加内容掩盖</td></tr>
  <tr><td><b>G2 系统冻结</b></td><td>关键数值均有实测答案；此后只修不增</td></tr>
  <tr><td><b>G3 内容冻结</b></td><td>全流程可通、无卡死、单周目时长达标</td></tr>
  <tr><td><b>G4 build 冻结</b></td><td>稳定运行 60 分钟以上、致命 bug 为 0、前 10 分钟引导完整</td></tr>
  ${d.fest ? `<tr><td><b>档期硬线</b></td><td>媒体预览线 ${esc(d.fest.media)} ｜ build 冻结 ${esc(d.fest.freeze)} ｜ 开幕 ${esc(d.fest.open)}</td></tr>` : ''}
</table>

<div class="foot">由 Steam 市场侦察兵（SteamScout）生成 · 人日估算按品类复杂度系数 ${d.factor}、每周 5 天、专注系数 0.8 折算 · 建议每周更新实际进度，偏差超过 1 周即重排</div>
</body></html>`;
}

/** 判断信息是否足够排期，返回缺失项与追问文案 */
export function planGaps(brief = {}) {
  const gaps = [];
  // 注意：这里不能用 normalizeScope（它会补默认值，导致"缺内容体量"永远检测不到）
  const raw = brief.scope || {};
  const hasScope = ['chapters', 'cards', 'bosses', 'levels', 'characters', 'words'].some((k) => Number(raw[k]) > 0);
  if (!brief.targetState || String(brief.targetState).trim().length < 4) {
    gaps.push({
      key: 'targetState',
      q: '**下一阶段想达成什么状态？**（例如「可玩 2 章、单周目 2 小时、带 1 个 Boss 的 Demo」，或「能上 Steam 商店页的垂直切片」）',
    });
  }
  if (!hasScope) {
    gaps.push({
      key: 'scope',
      q: '**具体要做多少内容？**（章节数 / 卡牌数 / 关卡数 / Boss 数 / 角色数，给个大概就行，例如「2 章 / 120 张卡 / 3 个 Boss」）',
    });
  }
  if (!brief.deadline && !brief.festOpen && !brief.noDeadline) {
    gaps.push({
      key: 'deadline',
      q: '**有没有硬时间点？**（发售日期，或想对标的 Steam 新品节，例如「2027 年 6 月新品节」；没有就说"没有"，我按最快路径排）',
    });
  }
  return gaps;
}

/** 追问文案：先回显"已确认的信息"，再只问还缺的项（问过的不再出现在这里） */
export function buildPlanQuestions(brief, gaps) {
  const L = [];
  const known = [
    brief.name && brief.name !== '未命名项目' ? `项目《${brief.name}》` : null,
    brief.genre ? `品类「${brief.genre}」` : null,
    brief.teamSize ? `团队 ${brief.teamSize} 人` : null,
    brief.milestone ? `里程碑 ${brief.milestone}` : null,
    brief.targetState ? `目标状态「${String(brief.targetState).slice(0, 40)}」` : null,
    (brief.scope && ['chapters', 'cards', 'bosses', 'levels', 'characters', 'words'].some((k) => brief.scope[k] > 0))
      ? `内容体量 ${
        [brief.scope.chapters ? `${brief.scope.chapters} 章` : null,
          brief.scope.cards ? `${brief.scope.cards} 张卡` : null,
          brief.scope.bosses ? `${brief.scope.bosses} 个 Boss` : null,
          brief.scope.levels ? `${brief.scope.levels} 个关卡` : null,
          brief.scope.characters ? `${brief.scope.characters} 个角色` : null,
          brief.scope.words ? `${Math.round(brief.scope.words / 10000)} 万字` : null].filter(Boolean).join(' / ')}`
      : null,
    brief.festOpen ? `对标 ${brief.festOpen} 的新品节` : null,
    brief.deadline ? `截止 ${brief.deadline}` : null,
    brief.noDeadline ? '不设硬截止（按最快路径）' : null,
  ].filter(Boolean);

  L.push(gaps.length === 1 ? '## 还差一个信息，补上就出甘特图' : `## 还差 ${gaps.length} 个信息，补上就出甘特图`);
  L.push('');
  if (known.length) {
    L.push(`**已确认**：${known.join('｜')}`);
    L.push('');
  }
  gaps.slice(0, 3).forEach((g, i) => L.push(`${i + 1}. ${g.q}`));
  L.push('');
  L.push('> 一句话回答就够。也可以直接说「用默认假设先排」——我会用小团队常见配置先给一版，你再改。');
  return L.join('\n');
}

export function planSuggestions(projectName) {
  const n = projectName || '这个项目';
  return [
    { type: 'message', label: '📅 换成 Demo 口径重排', text: `用 Demo 口径重排《${n}》的周级甘特图：只做 1-2 章可玩内容` },
    { type: 'message', label: '🎯 帮我定 Demo 的验收标准', text: `针对《${n}》的 Demo，给出可量化的验收标准（玩家测试人数、通过率、时长、崩溃率）` },
    { type: 'export', label: '⤓ 导出甘特图 PDF' },
  ];
}

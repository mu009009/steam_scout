// 立项评估引擎：市场潜力评分 + 开发周期估算 + 上线窗口/时机评估
// 设计原则：市场未来不可预测 → 不铁口直断，给出三档工期、窗口评级、情景策略与季度检查信号
import { clamp, localNow, truncate } from './util.mjs';

// ---------- 开发周期基准表（结合 UP 主案例与行业公开案例） ----------
// months: [下限, 上限]（单人、中型范围、完整版）
const GENRE_BENCH = [
  { match: /吸血鬼|幸存者|survivors?/i, label: '幸存者like', months: [3, 8], note: '当前制作门槛最低的动作品类之一' },
  { match: /放置|挂机|idle|clicker/i, label: '放置/挂机', months: [6, 14], note: '参考《放置之路》：2人13个月、10万愿望单' },
  { match: /钓鱼|模拟经营|经营|农场|餐厅|商店|生活模拟|life.?sim|管理/i, label: '模拟经营/生活模拟', months: [6, 16], note: '参考 Friendslop（2天100万份）等爆款，内容量决定工期' },
  { match: /休闲|收纳|整理|清洁|小游戏|派对|party|jam/i, label: '休闲/收纳小游戏', months: [1.5, 5], note: '参考《玩具店大整理》：1人20天、首周5000+份' },
  { match: /肉鸽|rogue|卡牌|卡组|deck|爬塔/i, label: '肉鸽/卡牌', months: [10, 22], note: '数值系统与内容量是工期大头' },
  { match: /银河城|平台跳跃|平台动作|platformer|metroid/i, label: '2D 平台/银河城', months: [12, 28], note: '关卡设计成本高' },
  { match: /解谜|puzzle|视觉小说|文字|avg|gal/i, label: '解谜/视觉小说', months: [6, 18], note: '重内容创作，程序压力小' },
  { match: /塔防|tower.?defense/i, label: '塔防', months: [9, 18], note: '' },
  { match: /策略|4x|文明|城市建造|工厂|factory|殖民|战棋|rts|即时战略/i, label: '策略/建造', months: [18, 36], note: '系统复杂度高' },
  { match: /魂|souls|类魂|动作rpg|动作角色/i, label: '3D 动作', months: [24, 48], note: '动作手感打磨周期长' },
  { match: /物理|沙盒|破坏|体素|voxel/i, label: '3D 物理沙盒', months: [18, 40], note: '参考 BonkLab：单人1年才到预告阶段' },
  { match: /开放世界|大型rpg|mmo|网游|多人|coop|联机|在线/i, label: '大型/多人', months: [30, 60], note: '小团队慎入，联机与内容量双高' },
];
const DEFAULT_BENCH = { label: '中型独立游戏(通用)', months: [12, 24], note: '' };

function matchBench(text) {
  for (const b of GENRE_BENCH) if (b.match.test(text)) return b;
  return DEFAULT_BENCH;
}

export function estimateDevTime({ genre = '', description = '', teamSize = 1, experience = '有经验', dimension = '', scope = '' }) {
  const text = `${genre} ${description}`;
  const bench = matchBench(text);
  const dim = String(dimension || (bench.months[0] > 20 ? '3D' : '2D')).toLowerCase();
  const dimFactor = dim.includes('3') ? 1.6 : 1.0;
  const scopeFactor = /大型|开放世界|多周目|上百|100\+|完整主线|庞大|海量/i.test(scope + description)
    ? 1.5
    : /小型|小体量|demo|原型|极简|短平快|几小时|休闲/i.test(scope + description)
      ? 0.6
      : 1.0;
  const n = Math.max(1, Math.round(Number(teamSize) || 1));
  const eff = n === 1 ? 1.0 : n === 2 ? 0.72 : n === 3 ? 0.6 : n === 4 ? 0.52 : n === 5 ? 0.47 : 0.42;
  const expFactor = /资深|10年|十年|老手|做过.*上线/i.test(experience) ? 0.8 : /新手|学生|第一次|零经验|没做过/i.test(experience) ? 1.45 : 1.0;
  const base = ((bench.months[0] + bench.months[1]) / 2) * dimFactor * scopeFactor * eff * expFactor;
  const r1 = (x) => Math.round(x * 10) / 10;
  const months = {
    optimistic: Math.max(2, r1(base * 0.7)),
    expected: Math.max(3, r1(base)),
    pessimistic: Math.max(5, r1(base * 1.5)),
  };
  const demo = Math.max(1, r1(months.expected * 0.4));
  const mvp = Math.max(2, r1(months.expected * 0.55));
  const ea = Math.max(4, r1(months.expected * 0.7));
  const polish = Math.max(2, r1(months.expected * 0.25));
  const routes = [
    { name: '路线A · 激进试水（MVP）', months: r1(mvp + 2), desc: `核心循环 MVP（${mvp}个月）+ 约8周愿望单预热后上线试水，验证需求再决定扩内容` },
    { name: '路线B · 均衡（EA 抢先体验）', months: r1(ea), desc: `${ea}个月进抢先体验，边卖边迭代 6-12 个月再转正式版` },
    { name: '路线C · 完整打磨（直接 1.0）', months: r1(months.expected + polish), desc: `${months.expected}个月完成内容 + ${polish}个月打磨与宣发，直接正式发售` },
  ];
  return {
    genreLabel: bench.label,
    dimension: dim.includes('3') ? '3D' : '2D',
    months,
    milestones: { demo, mvp, ea, polish },
    routes,
    formulaNote: `${bench.label}基准 ${bench.months[0]}-${bench.months[1]} 月(单人) × 维度${dimFactor} × 范围${scopeFactor} × 团队效率${eff}(${n}人) × 经验${expFactor}。${bench.note}`,
  };
}

// ---------- 市场潜力评分 ----------
// m = { genre, competitors:[{appid,name,price,reviews,positivePct,releaseYear,peak24h}], releasesByYear:{}, upcomingCount, topGameAgeMonths, recentHitAgeMonths, chineseShare, description, kbInsight }
// 每个维度带 status：ok=数据充足 / partial=部分数据 / no-data=无数据(中性50分) / no-signal=分析已跑但无显著信号
export function scoreMarket(m = {}) {
  const dims = [];
  const competitors = (m.competitors ?? []).filter(Boolean);
  const releasesByYear = m.releasesByYear ?? {};
  const years = Object.keys(releasesByYear).map(Number).filter((y) => y > 2000).sort();
  const curYear = new Date().getFullYear();
  const thisYear = releasesByYear[curYear] ?? null;
  const prevYear = releasesByYear[curYear - 1] ?? null;
  const hasReleases = Object.keys(releasesByYear).length > 0;
  const upcoming = m.upcomingCount ?? null;
  let momentum = 'flat';
  let hype = false;

  // 1. 需求规模 (25)
  {
    const withReviews = competitors.filter((c) => c.reviews && c.reviews > 0);
    let score = 50, detail, status, gaps = [];
    if (withReviews.length) {
      const totalSalesEst = withReviews.reduce((s, c) => s + c.reviews * 35, 0); // Steam 评价数×~35 ≈ 销量
      score = clamp(10 + Math.log10(1 + totalSalesEst) / Math.log10(1e6) * 90, 10, 98);
      const topPeak = Math.max(0, ...competitors.map((c) => c.peak24h ?? 0));
      const peakNote = competitors.some((c) => c.peakSource === 'official-current') ? '（含官方当前在线兜底值）' : '';
      detail = `头部${Math.min(withReviews.length, 10)}款估算总销量约${totalSalesEst >= 10000 ? (totalSalesEst / 10000).toFixed(1) + '万' : Math.round(totalSalesEst)}份；品类最高24h在线${topPeak}${peakNote}`;
      status = competitors.length >= 3 ? 'ok' : 'partial';
      if (status === 'partial') gaps = ['热销竞品样本不足3款'];
      // 品类标签没定位到 → 竞品是泛样本，需求规模高估风险很大，必须降级并标注
      if (m.tagResolved === false) {
        score = Math.min(score, 62);
        status = 'partial';
        gaps = [...(gaps || []), '品类标签未定位（竞品为近似样本，需求规模可能高估）'];
        detail += '；⚠️ 未定位到该品类标签，样本可能包含非同类游戏';
      }
    } else {
      detail = '未获取到竞品评价/销量数据，无法估算需求规模，按中性 50 分处理';
      status = 'no-data';
      gaps = ['热销竞品详情（评价数）', '品类在线人数'];
    }
    dims.push({ name: '需求规模', weight: 25, score: Math.round(score), detail, status, gaps });
  }

  // 2. 竞争强度 (20)：得分越高 = 竞争越小（越蓝海）；缺失的子指标不参与加权
  {
    const parts = [];
    const gaps = [];
    if (hasReleases) {
      const recentCount = Object.entries(releasesByYear)
        .filter(([y]) => Number(y) >= curYear - 1)
        .reduce((s, [, n]) => s + n, 0);
      const intensity = clamp(recentCount / 120, 0, 1);
      parts.push({ w: 50, score: clamp(100 - intensity * 100, 5, 100), label: `近两年新游${recentCount}款（拥挤度${Math.round(intensity * 100)}%）` });
    } else {
      gaps.push('品类新游发行列表（Steam 商店搜索未返回：限流或品类标签未匹配）');
    }
    if (competitors.length >= 5) {
      const totalReviews = competitors.reduce((s, c) => s + (c.reviews ?? 0), 0) || 1;
      const top3 = [...competitors].sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0)).slice(0, 3);
      const headShare = top3.reduce((s, c) => s + (c.reviews ?? 0), 0) / totalReviews;
      parts.push({ w: 30, score: clamp(100 - headShare * 100, 5, 100), label: `头部3款占${Math.round(headShare * 100)}%评价量` });
    } else {
      gaps.push('热销竞品不足5款，无法评估头部集中度');
    }
    if (upcoming != null) {
      const upScore = clamp(100 - (Math.log10(1 + upcoming) / Math.log10(1000)) * 100, 5, 100);
      parts.push({ w: 20, score: Math.round(upScore), label: `即将上线${upcoming}款` });
    } else {
      gaps.push('即将上线竞品数量未获取到');
    }
    let score = 50, detail, status;
    if (parts.length) {
      const wsum = parts.reduce((s, p) => s + p.w, 0);
      score = parts.reduce((s, p) => s + p.score * p.w, 0) / wsum;
      detail = parts.map((p) => p.label).join('；');
      if (score < 40) detail += ' → 红海（竞争惨烈）';
      else if (score >= 70) detail += ' → 蓝海（竞争温和）';
      else detail += ' → 竞争中等';
      status = gaps.length ? 'partial' : 'ok';
    } else {
      detail = '无任何竞争相关数据，按中性 50 分处理';
      status = 'no-data';
    }
    if (m.kbInsight) detail += `。知识库参考：${truncate(m.kbInsight, 60)}`;
    dims.push({ name: '竞争强度(得分越高竞争越小)', weight: 20, score: Math.round(score), detail, status, gaps });
  }

  // 3. 增长趋势 (20)
  {
    let score = 50, detail, status, gaps = [];
    if (thisYear != null && prevYear != null && prevYear > 0) {
      const growth = (thisYear - prevYear) / prevYear;
      if (prevYear < 10) {
        // 上年度样本过少，同比不可靠
        score = 50;
        momentum = 'flat';
        status = 'partial';
        detail = `新游发行：${curYear - 1}年仅${prevYear}款 → ${curYear}年${thisYear}款，上年度样本过少（<10），同比数字不可靠，按中性 50 分处理`;
        gaps = [`${curYear - 1}年发行样本仅${prevYear}款，无法可靠计算同比（品类新游过多或过少都会导致300条样本窗口不足）`];
      } else {
        score = clamp(50 + growth * 250, 10, 95);
        momentum = growth > 0.25 ? 'rising' : growth < -0.15 ? 'declining' : 'flat';
        detail = `新游发行：${curYear - 1}年${prevYear}款 → ${curYear}年${thisYear}款（${growth >= 0 ? '+' : ''}${Math.round(growth * 100)}%）`;
        if (prevYear < 30) detail += `（样本为最近约300条新游，${curYear - 1}年数据可能不完整）`;
        if (momentum === 'flat') {
          status = 'no-signal';
          detail += ' → 同比基本持平，无明显趋势信号';
        } else {
          status = 'ok';
        }
      }
    } else if (hasReleases) {
      detail = `仅有 ${years.join('/')} 年数据，缺少上一年度对比样本，无法判断同比趋势，按中性 50 分处理`;
      status = 'partial';
      gaps = ['跨年度发行数据（品类新游过多或过少都会导致300条样本窗口不足一年）'];
    } else {
      detail = '未获取到品类新游发行数据，无法判断趋势，按中性 50 分处理';
      status = 'no-data';
      gaps = ['品类新游发行列表（Steam 商店搜索未返回）'];
    }
    const hitAge = m.recentHitAgeMonths ?? m.topGameAgeMonths;
    if (hitAge != null && hitAge <= 12) {
      hype = true;
      momentum = 'hype';
      detail += `；⚠️ 近期爆款上线仅${hitAge}个月 → 热点驱动期，窗口短且拥挤`;
    }
    if (upcoming != null && upcoming > 0) detail += `；即将上线竞品${upcoming}款`;
    dims.push({ name: '增长趋势', weight: 20, score: Math.round(score), detail, status, gaps });
  }

  // 4. 商业化空间 (15)
  {
    const prices = competitors.map((c) => c.price).filter((p) => p != null && !Number.isNaN(p) && p > 0);
    const pcts = competitors.map((c) => c.positivePct).filter((p) => p != null);
    const gaps = [];
    if (!prices.length) gaps.push('竞品价格');
    if (!pcts.length) gaps.push('竞品好评率');
    if (!prices.length && !pcts.length) {
      dims.push({ name: '商业化空间', weight: 15, score: 50, detail: '未获取到竞品价格与好评率数据，按中性 50 分处理', status: 'no-data', gaps });
    } else {
      let raw = 0, wsum = 0;
      const notes = [];
      if (prices.length) {
        const med = [...prices].sort((a, b) => a - b)[Math.floor(prices.length / 2)];
        raw += (med <= 20 ? 75 : med <= 40 ? 65 : med <= 70 ? 50 : 35) * 50;
        wsum += 50;
        notes.push(`品类价格中位数 ¥${med}（独游 15-50 元带最佳）`);
      }
      if (pcts.length) {
        const avg = pcts.reduce((s, p) => s + p, 0) / pcts.length;
        raw += clamp(avg * 1.2, 0, 100) * 50;
        wsum += 50;
        notes.push(`头部平均好评率 ${Math.round(avg)}%`);
      }
      dims.push({
        name: '商业化空间', weight: 15,
        score: Math.round(wsum ? raw / wsum : 50),
        detail: notes.join('；'),
        status: gaps.length ? 'partial' : 'ok',
        gaps,
      });
    }
  }

  // 5. 平台匹配度 (10)
  {
    const chineseShare = m.chineseShare;
    if (chineseShare != null) {
      dims.push({
        name: '平台匹配度', weight: 10,
        score: Math.round(clamp(50 + chineseShare * 40, 20, 95)),
        detail: `竞品支持简体中文比例 ${Math.round(chineseShare * 100)}%（Steam 国区是独游第一大市场）`,
        status: 'ok', gaps: [],
      });
    } else {
      dims.push({
        name: '平台匹配度', weight: 10, score: 70,
        detail: '未获取到竞品语言支持数据，按默认 70 分处理',
        status: 'no-data',
        gaps: ['竞品语言支持情况'],
      });
    }
  }

  // 6. 差异化空间 (10)
  {
    const desc = String(m.description ?? '');
    const uspHits = ['创新', '独特', '首创', '没有同类', '融合', '新玩法', '反转', 'meta', '中式', '国风', '联机', '合作', '剧情', '叙事'].filter((k) => desc.includes(k));
    if (uspHits.length) {
      dims.push({
        name: '差异化空间', weight: 10,
        score: Math.round(clamp(45 + uspHits.length * 15, 20, 90)),
        detail: `描述中识别到 ${uspHits.length} 个差异化信号（${uspHits.slice(0, 4).join('、')}）`,
        status: 'ok', gaps: [],
      });
    } else {
      dims.push({
        name: '差异化空间', weight: 10, score: 40,
        detail: '描述中未提及创新点/独特卖点，判为无差异化信号（提示：立项描述缺少与品类头部的区隔）',
        status: 'no-signal', gaps: [],
      });
    }
  }

  const total = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / 100);
  const letter = total >= 85 ? 'S' : total >= 70 ? 'A' : total >= 55 ? 'B' : total >= 40 ? 'C' : 'D';
  const completeness = Math.round((dims.filter((d) => d.status === 'ok').length / dims.length) * 100);

  return { total, letter, dims, completeness, momentum, hype, releasesByYear, upcomingCount: upcoming, dataSource: m.dataSource ?? null };
}

// ---------- 上线窗口评估 ----------
const RATING_ORDER = ['优', '良', '险', '闭'];
function downgrade(r) { const i = RATING_ORDER.indexOf(r); return RATING_ORDER[Math.min(i + 1, 3)]; }

export function assessWindow({ devMonthsExpected = 12, market = {} }) {
  const { momentum = 'flat', upcomingCount = 0, topGameAgeMonths = null } = market;
  let windowLen;
  switch (momentum) {
    case 'rising': windowLen = 24; break;
    case 'hype': windowLen = 12; break;
    case 'declining': windowLen = 9; break;
    default: windowLen = 15;
  }
  const need = devMonthsExpected;
  let rating = need <= windowLen * 0.5 ? '优' : need <= windowLen * 0.8 ? '良' : need <= windowLen * 1.2 ? '险' : '闭';
  if (upcomingCount >= 8) rating = downgrade(rating);
  if (momentum === 'declining') rating = downgrade(rating);

  const launchDate = new Date(Date.now() + need * 30.44 * 86400000).toISOString().slice(0, 10);
  const rationale = [];
  rationale.push(`品类动量：${momentum === 'rising' ? '上升期' : momentum === 'hype' ? '热点驱动期' : momentum === 'declining' ? '衰退期' : '平稳期'}，窗口预计约 ${windowLen} 个月`);
  rationale.push(`按基准工期 ${need} 个月计，上线时间约 ${launchDate}`);
  if (upcomingCount > 0) rationale.push(`已知即将上线竞品 ${upcomingCount} 款${upcomingCount >= 8 ? '（拥挤，窗口评级已下调）' : ''}`);
  if (momentum === 'hype') rationale.push('热点驱动品类降温快，窗口按 12 个月封顶');

  const strategies = {
    优: '窗口充裕：可走完整打磨路线（路线C），并预留宣发周期；仍建议每季度复查市场信号。',
    良: '窗口尚可：建议均衡路线（路线B，EA 抢先体验）降低风险，用抢先体验期观察窗口变化。',
    险: '窗口偏紧：建议激进路线（路线A，MVP 试水）抢先卡位；若坚持完整版，必须有强差异化护城河。',
    闭: '窗口基本关闭：基准工期下上线时品类红利大概率消退；建议调整范围（缩短到 MVP 级）、寻找差异化细分，或转向相邻品类。',
  };

  return {
    rating,
    windowLenMonths: windowLen,
    launchDate,
    needMonths: need,
    upcomingCount,
    rationale,
    strategy: strategies[rating],
    checkpoints: [
      '每季度：品类新游发行量（steam_store_search released_desc）是否继续上升',
      '每季度：头部竞品 24h 在线（steam_charts）是否见顶回落',
      '每月：品类内新爆款数量（好评>5000 的新作）是否仍在增加',
      '上线前 6 个月：愿望单增速是否达标（新品节前应有明确转化数据）',
      '上线前 3 个月：是否出现同类大厂产品/免费游戏入场',
    ],
  };
}

// ---------- 汇总报告 ----------
export function buildReport(brief, dev, market, win) {
  const lines = [];
  lines.push(`# 《${brief.name || '未命名项目'}》立项评估报告`);
  lines.push(`> 评估时间：${localNow()} ｜ 数据来源：Steam 商店实时数据 / SteamCharts / 网络检索 / 本地知识库${market.dataSource ? ` / 补充数据源 ${market.dataSource}` : ''} ｜ 本报告为概率性判断，市场未来不可预测，请结合最新数据滚动复查`);
  lines.push('');
  lines.push(`## 一、项目画像`);
  lines.push(`| 项目 | 内容 |`);
  lines.push(`|---|---|`);
  lines.push(`| 名称 | ${brief.name || '-'} |`);
  lines.push(`| 品类 | ${brief.genre || '-'}（匹配基准：${dev.genreLabel}） |`);
  lines.push(`| 维度 | ${dev.dimension} ｜ 团队 ${brief.teamSize ?? 1} 人（${brief.experience ?? '有经验'}） |`);
  lines.push(`| 简介 | ${(brief.description || '-').slice(0, 200)} |`);
  lines.push('');
  lines.push(`## 二、市场潜力评分：**${market.total} / 100（${market.letter} 级）**`);
  const STATUS_MARK = { ok: '✅', partial: '⚠️', 'no-data': '❌', 'no-signal': '➖' };
  const STATUS_TEXT = { ok: '数据充足', partial: '部分数据', 'no-data': '无数据·中性50分', 'no-signal': '无显著信号' };
  lines.push(`| 维度 | 权重 | 得分 | 状态 | 依据 |`);
  lines.push(`|---|---|---|---|---|`);
  for (const d of market.dims) lines.push(`| ${d.name} | ${d.weight}% | ${d.score} | ${STATUS_MARK[d.status]} ${STATUS_TEXT[d.status]} | ${d.detail} |`);
  lines.push('');
  lines.push('> 得分口径：需求/趋势/商业化/平台/差异化 **越高越好**；竞争强度 **越高 = 竞争越小（越蓝海）**。状态列区分「系统无数据（❌/⚠️，按中性处理）」与「分析已跑但无显著信号（➖）」。');
  const gapDims = market.dims.filter((d) => d.gaps && d.gaps.length);
  if (gapDims.length) {
    lines.push('');
    lines.push(`## 附：数据缺口说明（${gapDims.length} 个维度数据不完整）`);
    lines.push(`| 维度 | 缺失的数据 |`);
    lines.push(`|---|---|`);
    for (const d of gapDims) lines.push(`| ${d.name} | ${d.gaps.join('；')} |`);
    lines.push('');
    lines.push('> 缺口常见原因：Steam 商店接口限流（重试或稍后再评估可补齐）、品类标签未匹配（可在问题中写清楚品类名）、样本窗口不足。存在缺口时对应维度按中性 50 分计入，**总分置信度下降**。');
  }
  lines.push('');
  const gapNote = market.completeness < 60
    ? `> ⚠️ 数据完整度 ${market.completeness}%（仅 ${market.dims.filter((d) => d.status === 'ok').length}/${market.dims.length} 个维度数据充足），评分置信度有限，建议稍后重新评估补齐数据再决策。`
    : `> 数据完整度 ${market.completeness}%。`;
  lines.push(gapNote);
  if (market.dataSource) lines.push(`> 数据源说明：官方接口缺失的估算字段（拥有者/在线/销量近似）由「${market.dataSource}」补充；价格、好评率等仍以 Steam 官方接口为准。`);
  lines.push('');
  lines.push(`## 三、开发周期估算`);
  lines.push(`| 档位 | 工期 |`);
  lines.push(`|---|---|`);
  lines.push(`| 乐观 | ${dev.months.optimistic} 个月 |`);
  lines.push(`| **基准** | **${dev.months.expected} 个月** |`);
  lines.push(`| 悲观 | ${dev.months.pessimistic} 个月 |`);
  lines.push('');
  lines.push(`> ${dev.formulaNote}`);
  lines.push('');
  lines.push(`**里程碑**：垂直切片/Demo ~${dev.milestones.demo} 个月 → 核心循环 MVP ~${dev.milestones.mvp} 个月 → EA 可发布 ~${dev.milestones.ea} 个月 → 1.0 含打磨宣发 ~${dev.months.expected + dev.milestones.polish} 个月`);
  lines.push('');
  lines.push(`**三条路线**：`);
  for (const r of dev.routes) lines.push(`- ${r.name}：约 **${r.months} 个月**。${r.desc}`);
  lines.push('');
  lines.push(`## 四、上线窗口与时机评估：**${win.rating}**`);
  lines.push(`- 品类窗口预计约 **${win.windowLenMonths} 个月**；按基准工期上线时间约 **${win.launchDate}**`);
  for (const r of win.rationale) lines.push(`- ${r}`);
  lines.push('');
  lines.push(`**窗口策略**：${win.strategy}`);
  lines.push('');
  lines.push(`## 五、结论：立项建议`);
  const verdict = win.rating === '优' && market.total >= 70 ? 'GO ✅'
    : win.rating === '闭' || market.total < 40 ? 'NO-GO ❌'
      : '条件 GO ⚠️';
  lines.push(`**${verdict}** —— 综合市场潜力（${market.total}/100）与窗口（${win.rating}）。`);
  lines.push('');
  lines.push(`**季度检查信号**（滚动复查，出现恶化即调整策略）：`);
  for (const c of win.checkpoints) lines.push(`- [ ] ${c}`);
  lines.push('');
  lines.push(`## 六、风险与情景预案`);
  lines.push(`| 情景 | 假设 | 应对 |`);
  lines.push(`|---|---|---|`);
  lines.push(`| 乐观 | 品类热度延续、无大厂入场 | 按路线C推进，预留宣发预算 |`);
  lines.push(`| 中性 | 热度平稳回落 | 按路线B（EA）推进，用抢先体验期试探定价与内容方向 |`);
  lines.push(`| 悲观 | 窗口提前关闭/爆款后继乏力 | 范围砍至 MVP（路线A）快速上线，或转差异化细分再评估 |`);
  return lines.join('\n');
}

export function runEvaluation(brief) {
  const dev = estimateDevTime(brief);
  const market = scoreMarket(brief.market ?? { genre: brief.genre, description: brief.description });
  const win = assessWindow({ devMonthsExpected: dev.months.expected, market });
  const report = buildReport(brief, dev, market, win);
  return { dev, market, window: win, report };
}

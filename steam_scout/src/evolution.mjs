// 学习进化：市场快照 → 周期复盘 → 观点沉淀 → 调研队列自动执行
import { CONFIG } from './config.mjs';
import { addSnapshot, getLatestSnapshot, addInsight, setMeta, getMeta, addQueue, takeQueue, markQueueDone, upsertSource, sourceExists } from './db.mjs';
import { featuredCategories, steamCharts } from './tools/steam.mjs';
import { upVideos, videoInfo, videoSubtitle } from './tools/bilibili.mjs';
import { bingSearch } from './tools/websearch.mjs';
import { searchVideos } from './tools/bilibili.mjs';
import { distillFromText } from './agent.mjs';
import { llmConfigured, chat } from './llm.mjs';
import { invalidate } from './retriever.mjs';
import { localNow, truncate, parseJsonLoose } from './util.mjs';

async function takeMarketSnapshot() {
  try {
    const f = await featuredCategories();
    const seen = new Set();
    const top = f.topSellers
      .filter((g) => !seen.has(g.name) && (seen.add(g.name), true)) // 同一游戏多版本 appid 去重
      .slice(0, 5);
    const charts = {};
    for (const g of top.slice(0, 3)) {
      try { charts[g.appid] = await steamCharts(g.appid); } catch {}
    }
    const payload = { topSellers: top, newReleases: f.newReleases.slice(0, 10), comingSoon: f.comingSoon.slice(0, 10), charts, at: localNow() };
    addSnapshot('market', payload);
    return payload;
  } catch (e) {
    return null;
  }
}

/** 同步 UP 主新视频入库并提炼观点 */
export async function syncUpNewVideos() {
  try {
    const videos = await upVideos(CONFIG.upMid, { limit: 40 });
    const fresh = videos.filter((v) => !sourceExists('bili_video', v.bvid));
    let added = 0;
    for (const v of fresh.slice(0, 8)) {
      try {
        const info = await videoInfo(v.bvid);
        upsertSource('bili_video', v.bvid, {
          title: v.title,
          url: `https://www.bilibili.com/video/${v.bvid}`,
          raw: { ...v, desc: info.desc, stat: info.stat },
        });
        let subtitleText = '';
        try { const s = await videoSubtitle(v.bvid); subtitleText = s.subtitle || ''; } catch {}
        await distillFromText(`视频标题: ${v.title}\n简介: ${info.desc}\n字幕: ${subtitleText}`, {
          category: 'UP主观点', sourceType: 'bili_video', sourceRef: v.bvid,
          url: `https://www.bilibili.com/video/${v.bvid}`, maxInsights: 3, silent: true,
        });
        added++;
      } catch {}
    }
    return added;
  } catch { return 0; }
}

/** 市场复盘：对比快照 + 同步 up 主 + 新闻检索 + LLM 汇总 → 写入复盘报告 */
export async function runDigest({ force = false, log = console.log } = {}) {
  if (!CONFIG.evolution.enabled && !force) return null;
  const last = getMeta('last_digest', null);
  const hoursAgo = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
  if (!force && hoursAgo < CONFIG.evolution.intervalHours) return null;

  log('[evolution] 开始市场复盘…');
  const prev = getLatestSnapshot('market');
  const cur = await takeMarketSnapshot();
  const lines = [`【市场复盘 ${localNow()}】`];
  if (!cur) { log('[evolution] 快照失败'); return null; }

  if (prev) {
    const prevTop = prev.payload.topSellers.map((g) => g.appid);
    const curTop = cur.topSellers.map((g) => g.appid);
    const enter = curTop.filter((a) => !prevTop.includes(a)).length;
    lines.push(`Steam 热销榜变动：${enter} 款新进榜；新品榜 ${cur.newReleases.length} 款；即将推出 ${cur.comingSoon.length} 款。`);
  } else {
    lines.push(`Steam 热销榜 Top5：${cur.topSellers.map((g) => g.name).join('、')}；新品 ${cur.newReleases.length} 款。`);
  }
  for (const g of cur.topSellers) {
    const peak = cur.charts[g.appid]?.peak24h;
    lines.push(`- 热销: ${g.name}${peak ? `（24h峰值 ${peak}）` : ''}${g.discount ? `（-${g.discount}%）` : ''}`);
  }

  if (CONFIG.evolution.upSync) {
    const n = await syncUpNewVideos();
    if (n) lines.push(`UP 主「Gaby学姐说」新增 ${n} 期视频，已入库并提炼观点。`);
  }

  let news = [];
  try { news = (await bingSearch('Steam 独立游戏 市场 动态', 5)).results; } catch {}

  let summary = lines.join('\n');
  if (llmConfigured()) {
    try {
      const sys = '你是 Steam 市场分析师。基于原始观察写 200-300 字中文复盘要点：发生了什么变化、对独立游戏立项意味着什么、值得盯的品类。';
      const r = await chat({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: `${summary}\n\n新闻标题: ${news.slice(0, 5).map((n) => n.title).join('；')}` }],
        temperature: 0.4,
      });
      summary += `\n\nLLM 复盘要点：\n${r.content}`;
    } catch {}
  }
  addInsight({ content: truncate(summary, 1500), category: '复盘报告', tags: '市场复盘', sourceType: 'digest', weight: 1.2 });
  setMeta('last_digest', new Date().toISOString());
  invalidate();

  // 生成自动调研问题队列（自我进化）
  if (llmConfigured() && takeQueue(1).length === 0) {
    try {
      const sys = '你是市场研究员。基于复盘内容提出 2 个值得深入调研的问题（关于 Steam 品类趋势/立项机会），每个 30 字内。只输出 JSON 数组 ["...","..."]。';
      const r = await chat({ messages: [{ role: 'system', content: sys }, { role: 'user', content: summary.slice(0, 2000) }], temperature: 0.5 });
      const arr = parseJsonLoose(r.content);
      for (const q of (Array.isArray(arr) ? arr : []).slice(0, 2)) if (typeof q === 'string' && q.length > 4) addQueue(q);
    } catch {}
  }
  log('[evolution] 复盘完成');
  return summary;
}

/** 自动调研队列执行（每天限次） */
export async function runAutoResearch({ log = console.log } = {}) {
  if (!llmConfigured()) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const doneDate = getMeta('auto_research_date', '');
  const doneCount = doneDate === today ? Number(getMeta('auto_research_count', '0')) : 0;
  if (doneCount >= CONFIG.evolution.autoResearchMaxPerDay) return 0;
  const items = takeQueue(1);
  let n = 0;
  for (const it of items) {
    try {
      log(`[evolution] 自动调研: ${it.question}`);
      const parts = [];
      try {
        const s = await bingSearch(it.question, 5);
        parts.push(s.results.map((r) => `${r.title} ${r.snippet}`).join('\n'));
      } catch {}
      try { parts.push(JSON.stringify((await searchVideos(it.question, 5)).videos)); } catch {}
      const text = parts.join('\n').trim();
      if (text.length > 60) {
        await distillFromText(`调研问题: ${it.question}\n\n${text}`, { category: '调研结论', tags: '自动调研', sourceType: 'auto_research', maxInsights: 3, silent: true });
      }
      markQueueDone(it.id);
      n++;
    } catch {}
  }
  setMeta('auto_research_date', today);
  setMeta('auto_research_count', String(doneCount + n));
  return n;
}

export function startScheduler(log = console.log) {
  const tick = async () => {
    try {
      const h = new Date().getHours();
      if (h === CONFIG.evolution.digestHour) await runDigest({ log });
      else if (h % 6 === 1) await runAutoResearch({ log });
    } catch (e) { log('[evolution] 调度出错:', e.message); }
  };
  setInterval(tick, 3600 * 1000).unref();

  const last = getMeta('last_digest', null);
  if (CONFIG.evolution.enabled && (!last || Date.now() - new Date(last).getTime() > CONFIG.evolution.intervalHours * 3600000)) {
    setTimeout(() => runDigest({ log }).catch((e) => log('[evolution] 启动复盘失败:', e.message)), 30000);
  }
  log('[evolution] 进化调度器已启动（每小时检查，每日复盘）');
}

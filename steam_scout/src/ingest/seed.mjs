// 初始播种：抓取 B 站 UP 主「Gaby学姐说」全部视频 → 来源库 + 观点库
// 用法: node src/ingest/seed.mjs [--full] [--distill]
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../config.mjs';
import { upInfo, upVideos, videoInfo, videoSubtitle } from '../tools/bilibili.mjs';
import { upsertSource, sourceExists, addInsight, counts, setMeta, stmtAll } from '../db.mjs';
import { distillFromText } from '../agent.mjs';
import { llmConfigured } from '../llm.mjs';
import { chunk, truncate, sleep } from '../util.mjs';

export async function seed({ full = false, log = console.log } = {}) {
  log('=== Steam 市场侦察兵 · 初始调研播种 ===');
  log(`目标 UP 主 mid=${CONFIG.upMid}（Steam 独立游戏市场分析）`);
  const up = await upInfo(CONFIG.upMid);
  log(`UP 主: ${up.name}｜粉丝 ${up.fans}｜签名: ${up.sign}`);

  // 视频列表获取带风控重试（可断点续跑：已入库的视频自动跳过）
  let videos = null;
  for (let i = 0; i < 4 && !videos; i++) {
    try {
      videos = await upVideos(CONFIG.upMid, { limit: 500 });
    } catch (e) {
      const wait = 30 * (i + 1);
      log(`  ⚠️ 视频列表获取被风控拦截（${e.message}），${wait}s 后重试（${i + 1}/4）…`);
      await sleep(wait * 1000);
    }
  }
  if (!videos) throw new Error('视频列表获取失败（B站风控），请稍后重新运行本脚本（已入库内容会自动跳过）');
  log(`共发现 ${videos.length} 期视频，开始入库…`);

  const sorted = [...videos].sort((a, b) => b.play - a.play);
  const topN = sorted.slice(0, 12); // 高播放视频抓字幕深挖
  let added = 0;
  let subtitleCount = 0;

  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (sourceExists('bili_video', v.bvid) && !full) continue;
    try {
      const info = await videoInfo(v.bvid);
      let sub = null;
      if (topN.some((t) => t.bvid === v.bvid)) {
        try {
          const s = await videoSubtitle(v.bvid);
          sub = s.subtitle;
          if (sub) subtitleCount++;
        } catch {}
      }
      upsertSource('bili_video', v.bvid, {
        title: v.title,
        url: `https://www.bilibili.com/video/${v.bvid}`,
        raw: { ...v, desc: info.desc, stat: info.stat, tname: info.tname, subtitle: sub },
      });
      added++;
      log(`  [${added}/${videos.length}] ${v.title}（播放 ${v.play}）${sub ? ' [含字幕]' : ''}`);
    } catch (e) {
      log(`  [跳过] ${v.title}: ${e.message}`);
    }
  }
  log(`入库完成：新增 ${added} 期，其中 ${subtitleCount} 期含字幕。`);

  log('开始提炼观点…');
  if (llmConfigured()) {
    const batches = chunk(sorted, 10);
    for (const batch of batches) {
      const text = batch.map((v) => `《${v.title}》\n简介: ${v.desc}`).join('\n\n');
      await distillFromText(text, { category: 'UP主观点', tags: '立项方法论', sourceType: 'bili_video', maxInsights: 8, silent: true });
      log(`  已提炼 ${batch.length} 期（批次累计）`);
    }
  } else {
    log('  ⚠️ 未配置 LLM：按原始内容（标题+简介）入库；配置 key 后运行 node src/ingest/seed.mjs --distill 升级为提炼观点');
    for (const v of videos) {
      addInsight({
        content: truncate(`【${v.title}】${v.desc}`, 400),
        category: 'UP主观点',
        tags: '立项方法论',
        sourceType: 'bili_video', sourceRef: v.bvid,
        url: `https://www.bilibili.com/video/${v.bvid}`,
        weight: Math.round((1 + Math.log10(1 + v.play) / 2) * 100) / 100,
      });
    }
  }
  setMeta('seed_mid', CONFIG.upMid);
  setMeta('seed_at', new Date().toISOString());
  const c = counts();
  log(`=== 播种完成：知识库 ${c.insights} 条洞察 / ${c.sources} 条来源 ===`);
  return { up, videos: videos.length, added, subtitleCount };
}

/** 从已有来源重新提炼观点（补字幕后升级用；跳过与原始条目同源的去重） */
export async function reDistill({ log = console.log } = {}) {
  if (!llmConfigured()) {
    log('未配置 LLM，无法提炼。请先设置 DEEPSEEK_API_KEY。');
    return;
  }
  const rows = stmtAll(`SELECT * FROM sources WHERE type='bili_video' ORDER BY fetched_at DESC LIMIT 100`);
  log(`重新提炼 ${rows.length} 条来源…`);
  for (const batch of chunk(rows, 10)) {
    const text = batch
      .map((r) => {
        const raw = JSON.parse(r.raw || '{}');
        return `《${r.title}》\n简介: ${raw.desc || ''}\n字幕: ${(raw.subtitle || '').slice(0, 800)}`;
      })
      .join('\n\n');
    const added = await distillFromText(text, { category: 'UP主观点', tags: '立项方法论', sourceType: 'bili_video', maxInsights: 8, silent: true, skipDedupe: true });
    log(`  已提炼 ${batch.length} 期，新增 ${added.length} 条观点`);
  }
  log('重新提炼完成');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv[2] ?? '';
  (flag === '--distill' ? reDistill() : seed({ full: flag === '--full' }))
    .then(() => process.exit(0))
    .catch((e) => { console.error('播种失败:', e); process.exit(1); });
}

// 模块自检：逐层验证数据层/检索/Steam/B站/搜索/评估引擎
import { addInsight, counts, upsertSource, getLatestSnapshot } from '../src/db.mjs';
import { search, invalidate } from '../src/retriever.mjs';
import { appDetails, appReviews, steamSearch, steamCharts, popularTags, findTagId, storeSearch, featuredCategories, appTags } from '../src/tools/steam.mjs';
import { upInfo, upVideos, videoInfo, videoSubtitle, searchVideos } from '../src/tools/bilibili.mjs';
import { bingSearch } from '../src/tools/websearch.mjs';
import { runEvaluation, estimateDevTime } from '../src/evaluator.mjs';
import { CONFIG } from '../src/config.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' :: ' + extra : ''}`); }
}

console.log('== 1. 数据层 ==');
try {
  const id = addInsight({ content: '测试条目：幸存者like 品类 2026 年新游 120 款，头部《X》评价 5 万条', category: '测试', tags: '幸存者like,新游', weight: 1 });
  invalidate();
  const r = search('幸存者 新游');
  t('addInsight + 检索命中', r.some((x) => x.id === id), `命中 ${r.length} 条, top score=${r[0]?.score}`);
  upsertSource('test', 't1', { title: '测试源', raw: { a: 1 } });
  t('upsertSource + 统计', counts().sources >= 1, `sources=${counts().sources}`);
} catch (e) { t('数据层', false, e.message); }

console.log('== 2. Steam 工具 ==');
try {
  const d = await appDetails(730);
  t('appDetails(730)', d.name === 'Counter-Strike 2', d.name);
  const rv = await appReviews(730);
  t('appReviews(730)', rv.total > 0, `评价 ${rv.total} 条, 好评率 ${Math.round(rv.positive / rv.total * 100)}%`);
  const s = await steamSearch('吸血鬼幸存者', 3);
  t('steamSearch', s.items.length > 0, `${s.items[0]?.name} (${s.items[0]?.appid})`);
  const ch = await steamCharts(730);
  t('steamCharts(730)', ch.peak24h > 0, `24h峰值 ${ch.peak24h}`);
  const tags = await popularTags();
  t('popularTags', tags.length > 50, `${tags.length} 个标签`);
  const tag = await findTagId('模拟');
  t('findTagId(模拟)', Boolean(tag), tag ? `tagid=${tag.tagid}(${tag.name})` : '');
} catch (e) { t('Steam 工具组', false, e.message); }

console.log('== 3. Steam 商店搜索页 ==');
try {
  const r = await storeSearch({ tagId: (await findTagId('模拟'))?.tagid, sort: 'released_desc', limit: 30 });
  t('storeSearch 新游', r.rows.length > 0, `total=${r.total}, rows=${r.count}, 样例: ${r.rows[0]?.title} | ${r.rows[0]?.released} | ${r.rows[0]?.price}`);
  const up = await storeSearch({ tagId: (await findTagId('模拟'))?.tagid, sort: 'coming_soon', limit: 30 });
  t('storeSearch 即将推出', up.rows.length >= 0, `total=${up.total}`);
} catch (e) { t('storeSearch', false, e.message); }

console.log('== 4. B 站工具 ==');
try {
  const up = await upInfo(CONFIG.upMid);
  t('upInfo', up.name === 'Gaby学姐说', `${up.name}（粉丝 ${up.fans}）`);
  const vids = await upVideos(CONFIG.upMid, { limit: 5 });
  t('upVideos', vids.length > 0, `${vids.length} 条, 最新: ${vids[0]?.title}`);
  const info = await videoInfo(vids[0].bvid);
  t('videoInfo', info.title.length > 0, `播放 ${info.stat?.view}`);
  const sub = await videoSubtitle(vids[0].bvid);
  t('videoSubtitle', typeof sub.subtitle === 'string' || sub.subtitle === null, sub.subtitle ? `字幕 ${sub.subtitle.length} 字` : (sub.note || ''));
  const sv = await searchVideos('Steam 独立游戏 立项', 3);
  t('searchVideos', sv.videos.length > 0, sv.videos[0]?.title);
} catch (e) { t('B 站工具组', false, e.message); }

console.log('== 5. 网络搜索 ==');
try {
  const b = await bingSearch('Steam 独立游戏 市场 2026', 5);
  t('bingSearch', b.results.length > 0, `${b.results.length} 条, 首条: ${b.results[0]?.title}`);
} catch (e) { t('bingSearch', false, e.message); }

console.log('== 6. 评估引擎 ==');
try {
  const dev = estimateDevTime({ genre: '肉鸽卡牌', description: '2D 卡组构筑', teamSize: 2, experience: '有经验' });
  t('estimateDevTime', dev.months.expected > 0 && dev.months.pessimistic >= dev.months.expected, `基准 ${dev.months.expected} 月 [${dev.months.optimistic}~${dev.months.pessimistic}] (${dev.genreLabel})`);
  const out = runEvaluation({
    name: '测试项目', genre: '肉鸽卡牌', description: '2D 卡组构筑爬塔，中式水墨风',
    teamSize: 2, experience: '有经验', dimension: '2D', scope: '中型',
    market: {
      genre: '肉鸽卡牌',
      competitors: [
        { name: '杀戮尖塔', price: 60, reviews: 130000, positivePct: 97, releaseYear: 2019, peak24h: 30000 },
        { name: '怪物火车', price: 58, reviews: 20000, positivePct: 94, releaseYear: 2020, peak24h: 8000 },
        { name: '背包乱斗', price: 36, reviews: 15000, positivePct: 91, releaseYear: 2025, peak24h: 20000 },
        { name: '小丑牌', price: 54, reviews: 120000, positivePct: 98, releaseYear: 2024, peak24h: 40000 },
      ],
      releasesByYear: { 2024: 80, 2025: 110, 2026: 140 },
      upcomingCount: 6,
      topGameAgeMonths: 20,
      chineseShare: 1.0,
    },
  });
  t('runEvaluation 评分', out.market.total > 0 && out.market.total <= 100, `${out.market.total}/100 (${out.market.letter}) 窗口:${out.window.rating}`);
  t('报告生成', out.report.includes('立项评估报告') && out.report.includes('市场潜力评分'), `报告 ${out.report.length} 字`);
} catch (e) { t('评估引擎', false, e.message); }

console.log(`\n===== 自检结果: ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

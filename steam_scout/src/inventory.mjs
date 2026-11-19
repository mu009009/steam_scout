// 数据资产盘点：告诉你本地已有什么数据、多旧、哪些需要重新拉取
import { stmtAll, counts, listProjects, latestEvalMeta } from './db.mjs';
import { cacheStats } from './research-cache.mjs';

const STALE_DAYS = 7; // 超过 7 天视为需要重新拉取
const META_TAGS = new Set(['立项方法论', '立项评估', '评估', '自动调研', 'UP主观点', '市场复盘', '品类分析', '市场数据', '调研结论', '复盘报告']);
// 只有命中这些词的标签才算"品类"，避免把方法论/运营/数据口径等标签混进品类覆盖
const GENRE_HINTS = ['钓鱼', '模拟', '生存', '恐怖', '平台', '银河城', '肉鸽', 'roguelike', '卡牌', '塔防', '沙盒', '物理', '放置', '农场', '建造', '解谜', '视觉小说', '策略', '角色扮演', 'rpg', '动作', '休闲', '幸存者', '开放世界', '射击', '音乐', '多人', '合作', '经营', '养成', '战棋', '即时战略', '割草', '跑团', 'tcg', 'dbg'];
// 命中这些词的标签属于运营/发行/数据类主题，不算品类
const EXCLUDE_HINTS = ['发行', '运营', '宣发', '数据', 'demo', '策略', '方法论', '推广', '营销', '预算', '排期', '资源', '平台资源', '渠道', 'kol', 'steam平台', '平台数据'];
function isGenreTag(tag) {
  const t = String(tag).toLowerCase();
  if (EXCLUDE_HINTS.some((k) => t.includes(k))) return false;
  return GENRE_HINTS.some((k) => t.includes(k));
}

function daysAgo(ts) {
  if (!ts) return null;
  const t = new Date(String(ts).replace(' ', 'T')).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export function dataInventory() {
  const c = counts();

  // 品类覆盖：来自洞察 tags + 项目品类
  const tagMap = new Map();
  const getTag = (name) => {
    if (!tagMap.has(name)) tagMap.set(name, { name, insights: 0, projects: 0, lastAt: '' });
    return tagMap.get(name);
  };
  for (const r of stmtAll(`SELECT tags, created_at FROM insights`)) {
    for (const raw of String(r.tags || '').split(/[,，、]/)) {
      const t = raw.trim();
      if (!t || t.length > 12 || META_TAGS.has(t)) continue;
      const cur = getTag(t);
      cur.insights++;
      if (r.created_at > cur.lastAt) cur.lastAt = r.created_at;
    }
  }
  for (const p of listProjects()) {
    const g = String(p.genre || '').trim();
    if (!g || META_TAGS.has(g)) continue;
    const cur = getTag(g);
    cur.projects++;
    if (p.updated_at && p.updated_at > cur.lastAt) cur.lastAt = p.updated_at;
  }
  const genres = [...tagMap.values()]
    .filter((g) => g.projects > 0 || isGenreTag(g.name))
    .map((g) => {
      const d = daysAgo(g.lastAt);
      return {
        ...g,
        daysAgo: d,
        status: d == null ? 'none' : d <= STALE_DAYS ? 'fresh' : 'stale',
        lastAt: g.lastAt || null,
      };
    })
    .sort((a, b) => (b.insights + b.projects * 3) - (a.insights + a.projects * 3));

  const otherTagCount = [...tagMap.values()].filter((g) => !(g.projects > 0 || isGenreTag(g.name))).length;

  const projects = listProjects().map((p) => ({
    slug: p.slug,
    name: p.name,
    genre: p.genre,
    updated_at: p.updated_at,
    hasReport: Boolean(p.latest_eval),
    session: latestEvalMeta(p.slug)?.session ?? null,
  }));

  return {
    generatedAt: new Date().toISOString(),
    kb: {
      insights: c.insights,
      sources: c.sources,
      byCategory: stmtAll(`SELECT category, COUNT(*) AS n FROM insights GROUP BY category`),
      bySourceType: stmtAll(`SELECT type, COUNT(*) AS n FROM sources GROUP BY type`),
      lastDigest: c.lastDigest,
      snapshots: stmtAll(`SELECT kind, COUNT(*) AS n, MAX(created_at) AS last FROM snapshots GROUP BY kind`),
    },
    projects,
    genres,
    otherTagCount,
    queuePending: c.queuePending,
    cache: cacheStats(),
    rules: { staleDays: STALE_DAYS },
  };
}

/** 把盘点结果压缩成给 LLM 看的摘要文本 */
export function inventorySummary(inv) {
  const g = inv.genres
    .slice(0, 10)
    .map((x) => `${x.name}（洞察${x.insights}条${x.projects ? ` / 项目${x.projects}个` : ''}${x.daysAgo != null ? `，${x.daysAgo}天前` : ''}${x.status === 'stale' ? '，建议重新拉取' : ''}）`)
    .join('；');
  return `本地数据盘点（${inv.generatedAt.slice(0, 10)}）：洞察 ${inv.kb.insights} 条、来源 ${inv.kb.sources} 条、项目档案 ${inv.projects.length} 个、待调研队列 ${inv.queuePending} 条、上次复盘 ${inv.kb.lastDigest ?? '从未'}、运行期缓存 ${inv.cache.size} 条（${inv.cache.ttlMinutes}分钟有效）。品类覆盖：${g || '暂无'}${inv.otherTagCount ? `；另有 ${inv.otherTagCount} 个非品类主题标签（方法论/发行/运营等）` : ''}`;
}

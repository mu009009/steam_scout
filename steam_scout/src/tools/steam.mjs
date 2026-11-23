// Steam 数据工具：商店 API / 商店搜索页 / SteamCharts
import { CONFIG } from '../config.mjs';
import { fetchJson, fetchText, decodeEntities, htmlToText, truncate } from '../util.mjs';

const BASE = 'https://store.steampowered.com';

// ---------- 底层能力 ----------

// 商店接口快速失败参数（被限流时避免长时间挂起）
const FAST = { timeoutMs: 12000, retries: 2 };

export async function appDetails(appid) {
  const j = await fetchJson(`${BASE}/api/appdetails?appids=${appid}&cc=${CONFIG.steam.cc}&l=${CONFIG.steam.l}`, FAST);
  const d = j[String(appid)]?.data;
  if (!d || !d.steam_appid) return { error: `未找到 appid ${appid}` };
  return {
    appid: d.steam_appid,
    name: d.name,
    type: d.type,
    isFree: d.is_free,
    releaseDate: d.release_date?.date ?? '',
    comingSoon: Boolean(d.release_date?.coming_soon),
    developers: d.developers ?? [],
    publishers: d.publishers ?? [],
    genres: (d.genres ?? []).map((g) => g.description),
    categories: (d.categories ?? []).map((c) => c.description),
    price: d.is_free ? '免费' : (d.price_overview?.final_formatted ?? '未知'),
    metacritic: d.metacritic?.score ?? null,
    recommendations: d.recommendations?.total ?? null,
    chineseSupported: String(d.supported_languages ?? '').includes('简体中文'),
    shortDescription: truncate(d.short_description ?? '', 500),
  };
}

export async function appReviews(appid, lang = 'schinese') {
  const j = await fetchJson(`${BASE}/appreviews/${appid}?json=1&language=${lang}&num_per_page=0&purchase_type=all&filter=summary`, FAST);
  const q = j.query_summary ?? {};
  return {
    appid,
    total: q.total_reviews ?? 0,
    positive: q.total_positive ?? 0,
    negative: q.total_negative ?? 0,
    desc: q.review_score_desc ?? '',
  };
}

export async function steamSearch(term, limit = 10) {
  const j = await fetchJson(`${BASE}/api/storesearch/?term=${encodeURIComponent(term)}&cc=${CONFIG.steam.cc}&l=${CONFIG.steam.l}`, FAST);
  const items = (j.items ?? []).slice(0, limit).map((it) => ({
    appid: it.id,
    name: it.name,
    price: it.price ? `${it.price.final / 100} ${it.price.currency}` : '未知',
    metascore: it.metascore ?? null,
  }));
  return { total: j.total ?? items.length, items };
}

export async function steamCharts(appid) {
  const { text } = await fetchText(`https://steamcharts.com/app/${appid}`, { timeoutMs: 15000, retries: 2 });
  const nums = [...text.matchAll(/<span class="num">([\d,]+)<\/span>/g)].map((m) => parseInt(m[1].replace(/,/g, ''), 10));
  return { appid, currentPlayers: nums[0] ?? null, peak24h: nums[1] ?? null, allTimePeak: nums[2] ?? null };
}

/**
 * Steam 官方「当前在线人数」接口（免费、无需任何 Key）。
 * 用途：SteamCharts 拿不到在线数据时的兜底——当前在线 ≠ 24h 峰值，只能当下界用，调用方需注明来源。
 */
export async function currentPlayers(appid) {
  const j = await fetchJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(appid)}`, FAST);
  const n = j?.response?.player_count;
  return { appid, current: Number.isFinite(Number(n)) ? Number(n) : null };
}

export async function appTags(appid) {
  const { text } = await fetchText(`${BASE}/app/${appid}/?l=${CONFIG.steam.l}`, { timeoutMs: 20000, retries: 2 });
  const m = text.match(/<div class="glance_tags popular_tags"[\s\S]*?<\/div>\s*<\/div>/);
  if (!m) return [];
  const tags = [...m[0].matchAll(/class="app_tag"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((x) => decodeEntities(htmlToText(x[1], 60)).trim())
    .filter(Boolean);
  return tags;
}

/** 按名称核对一款 Steam 游戏（名称 → appid/标签/价格/评价），避免把新游名误判成"品类" */
export async function gameLookup(name, emit = null) {
  const norm = (s) => String(s).toLowerCase().replace(/[\s:：·\-—_®™'"“”]/g, '');
  const base = await steamSearch(name, 6);
  const target = norm(name);
  const hit = (base.items ?? []).find((it) => {
    const n = norm(it.name);
    return n === target || n.includes(target) || target.includes(n);
  });
  if (!hit) return { query: name, found: false, candidates: (base.items ?? []).slice(0, 3).map((i) => i.name) };
  const [detail, tags, reviews] = await Promise.all([
    appDetails(hit.appid).catch(() => null),
    appTags(hit.appid).catch(() => []),
    appReviews(hit.appid).catch(() => null),
  ]);
  if (emit) emit({ type: 'status', text: `已核对 Steam：《${hit.name}》（appid ${hit.appid}，标签：${(tags ?? []).slice(0, 6).join('、') || '无'}）` });
  return {
    query: name,
    found: true,
    appid: hit.appid,
    name: hit.name,
    tags: tags ?? [],
    price: detail?.price ?? null,
    isFree: Boolean(detail?.isFree),
    releaseDate: detail?.releaseDate ?? '',
    reviews: reviews?.total ?? null,
    positivePct: reviews?.total ? Math.round((reviews.positive / reviews.total) * 100) : null,
    shortDescription: detail?.shortDescription ?? '',
  };
}

// ---------- 标签 ----------

let tagsCache = null;
let tagsCacheAt = 0;

export async function popularTags() {
  if (tagsCache && Date.now() - tagsCacheAt < 86400000) return tagsCache;
  const j = await fetchJson(`https://store.steampowered.com/tagdata/populartags/${CONFIG.steam.l}`, FAST);
  const list = Array.isArray(j)
    ? j.filter((t) => t && t.tagid && t.name)
    : Object.entries(j?.tagid ?? {}).map(([tagid, name]) => ({ tagid, name }));
  tagsCache = list;
  tagsCacheAt = Date.now();
  return list;
}

export async function findTagId(name) {
  const tags = await popularTags();
  const hit = tags.find((t) => t.name === name) || tags.find((t) => t.name.includes(name)) || null;
  return hit ? { tagid: hit.tagid, name: hit.name } : null;
}

/** 泛用标签 ID（独立/单人/多人/动作等），不用于定义品类 */
export const GENERIC_TAGIDS = new Set([492, 4182, 3859, 19, 21, 122, 9, 599, 597, 113, 701, 699, 493, 70, 10, 1664, 2, 1697]);

/** 从搜索结果行的标签里反推品类标签：出现最频繁的非泛用标签 */
export function topTagIdFromRows(rows, minCount = 5) {
  const counts = new Map();
  for (const row of rows) {
    for (const t of row.tags ?? []) {
      if (GENERIC_TAGIDS.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= minCount ? { tagid: String(top[0]), count: top[1] } : null;
}

const tagNameCache = new Map();
/** 从商店搜索页提取标签中文名（热门榜之外的细分标签用） */
export async function tagNameById(tagid) {
  if (tagNameCache.has(tagid)) return tagNameCache.get(tagid);
  try {
    const { text } = await fetchText(`${BASE}/search/results/?tags=${tagid}&l=${CONFIG.steam.l}&count=1`, { retries: 2, timeoutMs: 15000 });
    const m = text.match(new RegExp(`data-value="${tagid}"[^>]*>[\\s\\S]*?<span class="tab_label">([^<]+)</span>`));
    const name = m ? decodeEntities(m[1]).trim() : null;
    if (name) tagNameCache.set(tagid, name);
    return name;
  } catch { return null; }
}

// ---------- 商店搜索页（按标签/关键词，支持新游/热销/即将推出排序） ----------

// 排序/过滤映射（infinite 端点实测可用值）
const SORTS = {
  released_desc: { sort_by: 'Released_DESC' },
  coming_soon: { filter: 'comingsoon' },
  topselling: { filter: 'topsellers' },
  reviews: { sort_by: 'Reviews_DESC' },
};

export async function storeSearch({ tagId = null, tagName = null, term = '', sort = 'released_desc', limit = 50, page = 0 } = {}) {
  let tag = tagId ? { tagid: tagId, name: String(tagId) } : null;
  if (!tag && tagName) tag = await findTagId(tagName);
  const extra = SORTS[sort] ?? { sort_by: String(sort) };
  const params = new URLSearchParams({
    term: term ?? '',
    start: String(page * limit),
    count: String(Math.min(limit, 100)),
    supportedlang: CONFIG.steam.l,
    ...extra,
  });
  if (tag) params.set('tags', tag.tagid);
  const { text } = await fetchText(`${BASE}/search/results/?${params.toString()}&infinite=1`, { timeoutMs: 18000, retries: 2 });

  // infinite=1 返回 JSON 包裹的转义 HTML；普通页面直接返回 HTML
  let html = text;
  let total = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && j.results_html) {
      html = j.results_html;
      total = Number(j.total_count) || null;
    }
  } catch { /* 非 JSON，按 HTML 处理 */ }
  if (total == null) {
    const totalM = html.match(/([\d,]+)\s*(?:results match|个结果)/);
    total = totalM ? parseInt(totalM[1].replace(/,/g, ''), 10) : null;
  }

  const starts = [];
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    if (!m[0].includes('search_result_row')) continue;
    const idm = m[0].match(/data-ds-appid="(\d+)"/);
    if (idm) starts.push({ index: m.index, appid: idm[1], tagids: (m[0].match(/data-ds-tagids="([^"]*)"/) || [])[1] });
  }
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const block = html.slice(from, Math.min(to, from + 30000));
    const pick = (re) => {
      const m = block.match(re);
      return m ? decodeEntities(htmlToText(m[1], 120)).trim() : '';
    };
    const tooltip = block.match(/data-tooltip-html="([^"]*)"/);
    let reviews = null, positivePct = null, reviewDesc = '';
    if (tooltip) {
      const tt = decodeEntities(tooltip[1].replace(/<br\s*\/?>/g, ' '));
      const rm = tt.match(/([\d,]+)\s*篇用户评测中有\s*(\d+)%/);
      if (rm) { reviews = parseInt(rm[1].replace(/,/g, ''), 10); positivePct = Number(rm[2]); }
      reviewDesc = tt.slice(0, 12).trim();
    }
    const priceFinal = block.match(/data-price-final="(\d+)"/);
    let tags = [];
    if (starts[i].tagids) {
      tags = starts[i].tagids.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => !Number.isNaN(x));
    }
    rows.push({
      appid: starts[i].appid,
      title: pick(/<span class="title">([\s\S]*?)<\/span>/),
      released: pick(/<div class="[^"]*search_released[^"]*">([\s\S]*?)<\/div>/),
      price: priceFinal ? Number(priceFinal[1]) / 100 : null,
      priceText: pick(/<div class="[^"]*discount_final_price[^"]*">([\s\S]*?)<\/div>/),
      review: reviewDesc,
      reviews,
      positivePct,
      tags,
    });
  }
  return { total, count: rows.length, rows, sort, tag: tag ? tag.name : null };
}

export async function featuredCategories() {
  const j = await fetchJson(`${BASE}/api/featuredcategories/?cc=${CONFIG.steam.cc}&l=${CONFIG.steam.l}`, FAST);
  const pick = (arr) =>
    (arr ?? []).slice(0, 15).map((it) => ({
      appid: it.id,
      name: it.name,
      discount: it.discount_percent ?? 0,
      price: it.final_price != null ? it.final_price / 100 : null,
      currency: it.currency ?? 'CNY',
    }));
  return {
    specials: pick(j.specials?.items),
    topSellers: pick(j.top_sellers?.items),
    newReleases: pick(j.new_releases?.items),
    comingSoon: pick(j.coming_soon?.items),
  };
}

// ---------- 工具注册 ----------

export const steamTools = [
  {
    name: 'steam_app_details',
    description: '获取 Steam 游戏详情：价格、类型、发行日期、开发商、评价推荐数、是否支持中文等。',
    parameters: { type: 'object', properties: { appid: { type: 'integer', description: 'Steam appid（数字）' } }, required: ['appid'] },
    handler: async (a) => appDetails(a.appid),
  },
  {
    name: 'steam_app_reviews',
    description: '获取 Steam 游戏好评率汇总（总评价数/好评数/差评数）。',
    parameters: { type: 'object', properties: { appid: { type: 'integer' } }, required: ['appid'] },
    handler: async (a) => appReviews(a.appid),
  },
  {
    name: 'steam_search',
    description: '按关键词搜索 Steam 游戏（返回 appid/名称/价格）。',
    parameters: { type: 'object', properties: { term: { type: 'string', description: '搜索词（支持中文）' }, limit: { type: 'integer', description: '最多返回条数，默认10' } }, required: ['term'] },
    handler: async (a) => steamSearch(a.term, a.limit ?? 10),
  },
  {
    name: 'steam_charts',
    description: '获取某游戏在 SteamCharts 的当前/24h峰值/历史峰值在线人数（衡量热度）。',
    parameters: { type: 'object', properties: { appid: { type: 'integer' } }, required: ['appid'] },
    handler: async (a) => steamCharts(a.appid),
  },
  {
    name: 'steam_store_search',
    description: '浏览 Steam 商店列表：按品类标签(中文名如"模拟""肉鸽"或英文名如"Roguelike")或关键词筛选，可按新游(released_desc)/即将推出(coming_soon)/热销(topselling)/好评(reviews)排序。返回新游发行趋势、竞品清单等市场数据。',
    parameters: {
      type: 'object',
      properties: {
        tag_name: { type: 'string', description: '品类标签名，如 模拟、钓鱼、肉鸽、生存、Roguelike' },
        term: { type: 'string', description: '关键词搜索（可选）' },
        sort: { type: 'string', description: '排序：released_desc/coming_soon/topselling/reviews', enum: ['released_desc', 'coming_soon', 'topselling', 'reviews'] },
        limit: { type: 'integer', description: '返回条数，默认50' },
        page: { type: 'integer', description: '页码，默认0' },
      },
      required: [],
    },
    handler: async (a) => storeSearch({ tagName: a.tag_name, term: a.term, sort: a.sort, limit: a.limit ?? 50, page: a.page ?? 0 }),
  },
  {
    name: 'steam_app_tags',
    description: '获取某游戏的热门用户自定义标签。',
    parameters: { type: 'object', properties: { appid: { type: 'integer' } }, required: ['appid'] },
    handler: async (a) => appTags(a.appid),
  },
  {
    name: 'steam_game_lookup',
    description: '按**游戏名称**核对 Steam 游戏：返回 appid / 官方名 / 用户标签 / 价格 / 评价数 / 好评率。用户提到具体游戏名（如《幸存者笔记》）时先用它核对，避免把新游名误判成"品类"；查不到要如实说查不到，不要猜品类。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '游戏名称（中文或英文）' } }, required: ['name'] },
    handler: async (a, ctx) => gameLookup(a.name, ctx?.emit ?? null),
  },
  {
    name: 'steam_featured',
    description: '获取 Steam 首页橱窗数据：热销榜、新品榜、即将推出、特惠。',
    parameters: { type: 'object', properties: {} },
    handler: async () => featuredCategories(),
  },
];

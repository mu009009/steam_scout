// 付费/第三方数据源适配层
// 设计：统一接口 + 可配置模板。内置 SteamSpy（免费，无需 key）+ 若干付费源预设；
// 任何 OpenAPI 风格的服务都可以用 custom 模式（URL 模板 + 字段映射）接入。
import { CONFIG } from '../config.mjs';
import { fetchText, truncate } from '../util.mjs';

/** 各数据源的默认 URL 模板（用户可在 .env 用 DATA_PROVIDER_URL 覆盖） */
export const PRESETS = {
  steamapi: { base: 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={appid}', free: true, label: 'Steam 官方 Web API（免费，无需 Key）' },
  steamspy: { base: 'https://steamspy.com/api.php?request=appdetails&appid={appid}', free: true, label: 'SteamSpy（免费，可能有 Cloudflare 拦截）' },
  gamalytic: { base: 'https://api.gamalytic.com/game/steam/{appid}', label: 'Gamalytic（付费）' },
  vginsights: { base: 'https://api.vginsights.com/v1/steam/{appid}', label: 'VG Insights（付费）' },
  steambase: { base: 'https://api.steambase.io/v1/games/{appid}', label: 'Steambase（付费）' },
  custom: { base: '', label: '自定义数据源' },
};

/** 默认字段映射（可从 .env 的 DATA_PROVIDER_MAP 覆盖） */
function defaultFieldMap(provider) {
  if (provider === 'steamapi') {
    return { peak24h: 'response.player_count' };
  }
  if (provider === 'steamspy') {
    return { name: 'name', owners: 'owners', price: 'price', reviewsNeg: 'negative', reviewsPos: 'positive', peak24h: 'ccu' };
  }
  return { reviews: 'reviews.total', positivePct: 'reviews.score', owners: 'owners', price: 'price', peak24h: 'ccu' };
}

export function dataProviderStatus() {
  const d = CONFIG.data ?? {};
  const provider = String(d.provider || '').trim().toLowerCase();
  const preset = PRESETS[provider];
  return {
    provider: provider || null,
    configured: Boolean(provider),
    free: Boolean(preset?.free),
    label: preset?.label ?? (provider ? provider : null),
    hasKey: Boolean(d.apiKey),
    apiKeyMasked: d.apiKey ? `${String(d.apiKey).slice(0, 4)}…${String(d.apiKey).slice(-4)}` : '',
    urlTemplate: d.urlTemplate || preset?.base || '',
    fieldMap: safeParse(d.fieldMap) || defaultFieldMap(provider),
    note: provider ? (preset ? `使用 ${preset.label} 补充数据` : '自定义数据源') : '未配置付费源：仅使用 Steam 官方接口 + SteamCharts',
  };
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function getPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** 用配置好的数据源补充单个游戏的统计（返回归一化字段，失败返回 null） */
export async function providerGameStats({ appid, name }, emit = null) {
  const status = dataProviderStatus();
  if (!status.configured) return null;
  if (!appid) return null;
  const url = String(status.urlTemplate || '')
    .replace('{appid}', encodeURIComponent(String(appid)))
    .replace('{name}', encodeURIComponent(String(name ?? '')));
  if (!url) return null;
  const headers = { 'content-type': 'application/json' };
  if (status.hasKey && CONFIG.data.apiKey) {
    // 付费源默认 Bearer；可用 DATA_PROVIDER_AUTH_HEADER / _AUTH_PREFIX 覆盖
    const headerName = CONFIG.data.authHeader || 'authorization';
    const prefix = CONFIG.data.authPrefix === undefined ? 'Bearer ' : CONFIG.data.authPrefix;
    headers[headerName] = `${prefix}${CONFIG.data.apiKey}`;
  }
  try {
    const { status: httpStatus, text } = await fetchText(url, {
      headers,
      timeoutMs: 15000,
      retries: 1,
    });
    if (/Just a moment|cf-browser-verification|challenge-platform|__cf_chl/i.test(text)) {
      throw new Error('该源返回 Cloudflare 人机验证页（服务器无法直连），请换源或改用官方 API');
    }
    let j;
    try { j = JSON.parse(text); } catch {
      throw new Error(`响应不是 JSON（HTTP ${httpStatus}）${httpStatus === 401 || httpStatus === 403 || httpStatus === 404 ? '——可能是 Key 无效、额度用尽或该源不支持直连' : ''}`);
    }
    if (httpStatus !== 200) throw new Error(`HTTP ${httpStatus}——可能是 Key 无效/额度用尽/路径不对`);
    const map = status.fieldMap || {};
    const out = { source: status.label, appid };
    if (map.name) { const v = getPath(j, map.name); if (v) out.name = String(v); }
    if (map.owners) { const v = getPath(j, map.owners); if (v != null) out.owners = String(v); }
    if (map.price) { const v = getPath(j, map.price); if (v != null) out.price = Number(v); }
    if (map.peak24h) { const v = getPath(j, map.peak24h); if (v != null) out.peak24h = Number(v); }
    if (map.reviews) { const v = getPath(j, map.reviews); if (v != null) out.reviews = Number(v); }
    if (map.positivePct) { const v = getPath(j, map.positivePct); if (v != null) out.positivePct = Number(v); }
    // SteamSpy 特殊：用 positive/negative 计数换算
    if (map.reviewsPos && map.reviewsNeg) {
      const p = Number(getPath(j, map.reviewsPos) ?? 0);
      const n = Number(getPath(j, map.reviewsNeg) ?? 0);
      if (p + n > 0) { out.reviews = p + n; out.positivePct = Math.round((p / (p + n)) * 100); }
    }
    if (emit) emit({ type: 'status', text: `数据源 ${status.label} 补充：${out.name || `appid ${appid}`}${out.owners ? `，拥有者 ${out.owners}` : ''}${out.reviews ? `，评价 ${out.reviews}` : ''}${out.peak24h != null ? `，在线 ${out.peak24h}` : ''}` });
    return out;
  } catch (e) {
    if (emit) emit({ type: 'status', text: `⚠️ 数据源 ${status.label} 调用失败（${truncate(String(e.message || e), 80)}），继续用官方接口数据` });
    return null;
  }
}

/**
 * 批量补充竞品数据；返回 { competitors, sourceUsed, truncated }
 * 只补缺失字段，避免覆盖 Steam 官方更权威的数据；带总时限，避免拖垮评估流水线。
 */
export async function enrichCompetitors(competitors, emit = null, { maxCalls = 6, budgetMs = 30000 } = {}) {
  const status = dataProviderStatus();
  if (!status.configured || !competitors?.length) return { competitors, sourceUsed: null, truncated: false };
  const deadline = Date.now() + budgetMs;
  let used = 0;
  let calls = 0;
  let truncated = false;
  for (const c of competitors) {
    if (!c.appid) continue;
    // 只补缺失字段，避免覆盖 Steam 官方更权威的数据
    const need = c.reviews == null || c.peak24h == null || !c.owners;
    if (!need) continue;
    if (calls >= maxCalls || Date.now() > deadline) { truncated = true; break; }
    calls++;
    const s = await providerGameStats({ appid: c.appid, name: c.name }, emit);
    if (!s) continue;
    used++;
    if (s.reviews != null) c.reviews = c.reviews ?? s.reviews;
    if (s.positivePct != null) c.positivePct = c.positivePct ?? s.positivePct;
    if (s.price != null) c.price = c.price ?? s.price;
    if (s.peak24h != null) c.peak24h = c.peak24h ?? s.peak24h;
    if (s.owners != null) c.owners = s.owners;
    c.dataSource = s.source;
  }
  if (truncated && emit) emit({ type: 'status', text: `（数据源补充已达时间/次数上限，剩余竞品沿用官方数据）` });
  return { competitors, sourceUsed: used ? status.label : null, truncated };
}

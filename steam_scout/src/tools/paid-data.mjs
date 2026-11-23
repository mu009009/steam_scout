// 付费/第三方数据源适配层
// 设计：统一接口 + 可配置模板。内置已核实的免费源 + 付费源预设；
// 任何返回 JSON 的接口都可以用 custom 模式（URL 模板 + 字段映射）接入。
//
// ⚠️ 核实记录（2026-11 实测，勿凭印象加减数据源）：
//   steamapi  ✅ 实测 200，返回 response.player_count，免费无需 Key
//   steamspy  ⚠️ 官网对服务器请求返回 Cloudflare 人机验证（HTTP 403 challenge），成功率不稳
//   gamalytic ✅ 接口真实存在：无 Key 返回 403 "This endpoint requires an API key"
//               路径为 /game/{appid}（不是 /game/steam/{appid}）；API 需 Starter($25/月) 及以上
//   vginsights ❌ 已被 Sensor Tower 收购，vginsights.com 跳转 app.sensortower.com/vgi，
//               api.vginsights.com 无法解析；只有企业版 API，需商务联系 → 未内置
//   steambase  ❌ 只有面向玩家的网站 / Discord、Slack 机器人，没有公开数据 API → 未内置
import { CONFIG } from '../config.mjs';
import { fetchText, truncate } from '../util.mjs';

/** 各数据源的默认 URL 模板（用户可在 .env 用 DATA_PROVIDER_URL 覆盖） */
export const PRESETS = {
  steamapi: {
    base: 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={appid}',
    free: true,
    label: 'Steam 官方 Web API（免费·无需 Key）',
    howto: '免费、无需 Key：只能拿到「当前在线人数」。想用其它官方接口（玩家信息等）可在 steamcommunity.com/dev/apikey 免费申请一个 Key。',
    signup: 'https://steamcommunity.com/dev/apikey',
  },
  steamspy: {
    base: 'https://steamspy.com/api.php?request=appdetails&appid={appid}',
    free: true,
    hidden: true,
    label: 'SteamSpy（免费·实测被 Cloudflare 全拦）',
    howto: '免费、无需 Key，理论上能给拥有者区间与好评/差评数。但 2026-11 实测：无论换什么请求头，该站对程序请求一律返回 Cloudflare 人机验证页（HTTP 403 challenge），**基本不可用**，所以不在下拉里默认提供。若你想自己再试，可在「自定义」里填它的 URL 试试。',
    signup: 'https://steamspy.com/api.php',
  },
  gamalytic: {
    base: 'https://api.gamalytic.com/game/{appid}',
    keyParam: 'apiKey',
    label: 'Gamalytic（$25/月起，含 API 额度）',
    howto: '目前唯一「自己公布价格 + 公布误差研究」的 Steam 销量估算商：Starter $25/月（2500 次/天）、Professional $75/月（完整 API），有免费额度档。注册后在控制台复制 API Key 填进来。接口已核实存在（无 Key 时返回 403）。',
    signup: 'https://gamalytic.com/',
  },
  custom: {
    base: '',
    label: '自定义数据源（任意 JSON 接口）',
    howto: '任何返回 JSON 的接口都能接：填 URL 模板（支持 {appid} / {name} 占位）与字段映射，例如 Apify 抓取器、自建代理、公司内部数据服务。',
  },
};

/** 默认字段映射（可从 .env 的 DATA_PROVIDER_MAP 覆盖） */
function defaultFieldMap(provider) {
  if (provider === 'steamapi') {
    return { peak24h: 'response.player_count' };
  }
  if (provider === 'steamspy') {
    return { name: 'name', owners: 'owners', price: 'price', reviewsNeg: 'negative', reviewsPos: 'positive', peak24h: 'ccu' };
  }
  // gamalytic：销量/收入/拥有者齐备（字段名以其文档为准，可在 DATA_PROVIDER_MAP 覆盖）
  if (provider === 'gamalytic') {
    return { name: 'name', owners: 'owners', copiesSold: 'copiesSold', revenue: 'revenue', reviews: 'reviews', positivePct: 'reviewScore', price: 'price', peak24h: 'players.peakAll' };
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
    hidden: Boolean(preset?.hidden),
    label: preset?.label ?? (provider ? provider : null),
    hasKey: Boolean(d.apiKey),
    apiKeyMasked: d.apiKey ? `${String(d.apiKey).slice(0, 4)}…${String(d.apiKey).slice(-4)}` : '',
    urlTemplate: d.urlTemplate || preset?.base || '',
    fieldMap: safeParse(d.fieldMap) || defaultFieldMap(provider),
    keyParam: preset?.keyParam ?? '',
    howto: preset?.howto ?? '',
    signup: preset?.signup ?? '',
    blockedUntil: breaker.blockUntil > Date.now() ? new Date(breaker.blockUntil).toISOString() : null,
    note: provider ? (preset ? `使用 ${preset.label} 补充数据` : '自定义数据源') : '未配置付费源：仅使用 Steam 官方接口 + SteamCharts',
  };
}

/**
 * 熔断器：连续失败 2 次后 30 分钟内不再尝试该源。
 * 目的：免费源被 Cloudflare 拦时，别在每次评估里都白等 6 次 × 15 秒。
 */
const breaker = { fails: 0, blockUntil: 0, lastError: '' };
const BREAK_AFTER = 2;
const BREAK_MS = 30 * 60 * 1000;

export function providerBreakerState() {
  return { ...breaker, blocked: breaker.blockUntil > Date.now() };
}

function breakerFail(msg) {
  breaker.fails += 1;
  breaker.lastError = String(msg || '').slice(0, 200);
  if (breaker.fails >= BREAK_AFTER) breaker.blockUntil = Date.now() + BREAK_MS;
}

function breakerOk() { breaker.fails = 0; breaker.blockUntil = 0; breaker.lastError = ''; }

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
  if (breaker.blockUntil > Date.now()) return null; // 熔断期内直接跳过，不再浪费请求
  const rawUrl = String(status.urlTemplate || '')
    .replace('{appid}', encodeURIComponent(String(appid)))
    .replace('{name}', encodeURIComponent(String(name ?? '')));
  if (!rawUrl) return null;
  let url = rawUrl;
  const headers = { 'content-type': 'application/json' };
  if (status.hasKey && CONFIG.data.apiKey) {
    // 两种传法都带上，兼容「query 参数」与「Bearer 头」两类服务（多余的那个会被对方忽略）
    if (status.keyParam) {
      url += `${url.includes('?') ? '&' : '?'}${status.keyParam}=${encodeURIComponent(CONFIG.data.apiKey)}`;
    }
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
    if (httpStatus !== 200) {
      const msg = j?.message ? `：${truncate(String(j.message), 100)}` : '';
      throw new Error(`HTTP ${httpStatus}${msg}`);
    }
    const map = status.fieldMap || {};
    const out = { source: status.label, appid };
    if (map.name) { const v = getPath(j, map.name); if (v) out.name = String(v); }
    if (map.owners) { const v = getPath(j, map.owners); if (v != null) out.owners = String(v); }
    if (map.copiesSold) { const v = getPath(j, map.copiesSold); if (v != null) out.copiesSold = Number(v); }
    if (map.revenue) { const v = getPath(j, map.revenue); if (v != null) out.revenue = Number(v); }
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
    const bits = [];
    if (out.owners) bits.push(`拥有者 ${out.owners}`);
    if (out.copiesSold) bits.push(`销量估算 ${Math.round(out.copiesSold).toLocaleString('en-US')}`);
    if (out.revenue) bits.push(`收入估算 $${Math.round(out.revenue).toLocaleString('en-US')}`);
    if (out.reviews) bits.push(`评价 ${out.reviews}`);
    if (out.peak24h != null) bits.push(`在线 ${out.peak24h}`);
    breakerOk();
    if (emit) emit({ type: 'status', text: `数据源 ${status.label} 补充：${out.name || `appid ${appid}`}${bits.length ? `，${bits.join('，')}` : '（无可用字段）'}` });
    return out;
  } catch (e) {
    breakerFail(e?.message || e);
    // 同类错误只提示一次：避免 6 款竞品刷 6 行一模一样的话
    const msg = truncate(String(e.message || e), 90);
    if (emit && breaker.fails === 1) {
      emit({ type: 'status', text: `⚠️ 数据源 ${status.label} 调用失败（${msg}），继续用官方接口数据` });
    }
    if (breaker.blockUntil > Date.now() && emit) {
      emit({ type: 'status', text: `⏸ 数据源「${status.label}」连续失败 ${breaker.fails} 次，已暂停使用 30 分钟（本次评估不再尝试）；想要销量类数据可换成 Gamalytic 或先不接第三方源。` });
    }
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
  if (breaker.blockUntil > Date.now()) {
    if (emit) emit({ type: 'status', text: `⏸ 数据源「${status.label}」暂停中（最近失败：${truncate(breaker.lastError, 60)}），本次跳过，直接用官方数据` });
    return { competitors, sourceUsed: null, truncated: false, skippedByBreaker: true };
  }
  const deadline = Date.now() + budgetMs;
  let used = 0;
  let calls = 0;
  let truncated = false;
  for (const c of competitors) {
    if (!c.appid) continue;
    if (breaker.blockUntil > Date.now()) { truncated = true; break; } // 熔断后不再浪费请求
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
    if (s.copiesSold != null) c.copiesSold = s.copiesSold;
    if (s.revenue != null) c.revenue = s.revenue;
    c.dataSource = s.source;
  }
  if (truncated && emit) emit({ type: 'status', text: `（数据源补充已达时间/次数上限，剩余竞品沿用官方数据）` });
  return { competitors, sourceUsed: used ? status.label : null, truncated };
}

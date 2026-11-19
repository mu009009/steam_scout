import crypto from 'node:crypto';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function md5(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isNaN(code)) { try { return String.fromCodePoint(code); } catch { return m; } }
      return m;
    }
    return ENT[e] ?? m;
  });
}

/** HTML -> 纯文本（去脚本/样式/标签/实体） */
export function htmlToText(html, maxLen = 20000) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '\n…(截断)' : s;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 带重试与超时的文本抓取（连接失败/429/5xx 均自动重试，递增退避） */
export async function fetchText(url, { headers = {}, timeoutMs = 25000, retries = 4, method, body } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method, body,
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); await sleep(1500 * (i + 1)); continue; }
      return { status: res.status, text: await res.text(), headers: res.headers };
    } catch (e) { lastErr = e; if (i < retries) await sleep(1000 * (i + 1)); }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const { status, text } = await fetchText(url, opts);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`响应不是合法 JSON (HTTP ${status})`); }
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return j;
}

/** 简单限流器：两次调用至少间隔 ms */
export function rateLimit(ms) {
  let last = 0;
  return async function gate() {
    const wait = last + ms - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

export function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

export function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + `…(截断,原长${s.length})` : s; }

export function safeJsonParse(s, fallback = null) { try { return JSON.parse(s); } catch { return fallback; } }

/** 宽松 JSON 解析：兼容 markdown 代码块、{"items":[...]} 包裹、文本中嵌入的数组 */
export function parseJsonLoose(text, fallback = []) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let v = safeJsonParse(s, null);
  if (!Array.isArray(v) && v && typeof v === 'object') {
    const found = Object.values(v).find((x) => Array.isArray(x));
    if (found) v = found;
  }
  if (!Array.isArray(v)) {
    const m = s.match(/\[[\s\S]*\]/);
    v = m ? safeJsonParse(m[0], fallback) : fallback;
  }
  return v;
}

export function localNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

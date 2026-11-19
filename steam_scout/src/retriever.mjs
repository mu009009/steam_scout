// 本地知识库检索：CJK 二元组倒排索引 + TF-IDF 评分（零依赖）
import { stmtAll } from './db.mjs';

let cache = null;

const EN_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'and', 'is', 'are', 'with', 'this', 'that', 'it', 'as', 'at', 'be', 'by', 'or', 'game', 'games', 'steam']);

function tokenize(text) {
  const t = String(text).toLowerCase();
  const tokens = [];
  for (const m of t.matchAll(/[a-z0-9][a-z0-9.+-]{1,40}/g)) {
    if (m[0].length >= 2 && !EN_STOP.has(m[0])) tokens.push(m[0]);
  }
  for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function build() {
  const rows = stmtAll(`SELECT id, content, category, tags, weight, url, source_ref, source_type, created_at FROM insights`);
  cache = rows.map((r) => {
    const text = `${r.content}\n${r.tags}`;
    const tokens = tokenize(text);
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return {
      id: r.id, content: r.content, category: r.category, tags: r.tags, url: r.url,
      source_ref: r.source_ref, source_type: r.source_type, created_at: r.created_at,
      weight: Number(r.weight) || 1, len: tokens.length, tf,
    };
  });
}

export function invalidate() { cache = null; }

function likeFallback(query, { limit, category } = {}) {
  const like = `%${String(query).slice(0, 40)}%`;
  const rows = category
    ? stmtAll(`SELECT id, content, category, tags, url, source_ref, source_type, created_at, weight AS score FROM insights WHERE category=? AND content LIKE ? LIMIT ?`, [category, like, limit])
    : stmtAll(`SELECT id, content, category, tags, url, source_ref, source_type, created_at, weight AS score FROM insights WHERE content LIKE ? LIMIT ?`, [like, limit]);
  return rows.map((r) => ({ ...r, score: Math.round(r.score * 100) / 100 }));
}

export function search(query, { limit = 8, category = null } = {}) {
  const qts = tokenize(query);
  if (!cache) build();
  if (!qts.length) return likeFallback(query, { limit, category });

  const N = cache.length || 1;
  const docs = category ? cache.filter((d) => d.category === category) : cache;
  if (!docs.length) return [];

  const df = {};
  for (const d of docs) for (const t of Object.keys(d.tf)) df[t] = (df[t] || 0) + 1;
  const idf = (t) => Math.log(1 + N / ((df[t] || 0) + 1));

  const scored = [];
  for (const d of docs) {
    let s = 0;
    for (const t of qts) if (d.tf[t]) s += (1 + Math.log(d.tf[t])) * idf(t);
    if (s <= 0) continue;
    const norm = 1 / Math.sqrt(d.len || 1);
    scored.push({ score: s * norm * d.weight, doc: d });
  }
  scored.sort((a, b) => b.score - a.score);

  const out = scored.slice(0, limit).map(({ score, doc }) => ({
    id: doc.id,
    score: Math.round(score * 100) / 100,
    content: doc.content,
    category: doc.category,
    tags: doc.tags,
    url: doc.url,
    source_ref: doc.source_ref,
    source_type: doc.source_type,
    created_at: doc.created_at,
  }));
  return out.length ? out : likeFallback(query, { limit, category });
}

export function kbStats() {
  if (!cache) build();
  const byCat = {};
  for (const d of cache) byCat[d.category] = (byCat[d.category] || 0) + 1;
  return { total: cache.length, byCategory: byCat };
}

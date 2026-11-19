import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from './config.mjs';
import { localNow, safeJsonParse } from './util.mjs';

export const db = new DatabaseSync(CONFIG.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS insights(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  category TEXT DEFAULT '通用',
  tags TEXT DEFAULT '',
  source_type TEXT, source_ref TEXT, url TEXT,
  weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  meta TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_insights_cat ON insights(category);
CREATE TABLE IF NOT EXISTS sources(
  type TEXT, ref TEXT, title TEXT, url TEXT, fetched_at TEXT, raw TEXT,
  PRIMARY KEY(type, ref)
);
CREATE TABLE IF NOT EXISTS snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, payload TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots ON snapshots(kind, id);
CREATE TABLE IF NOT EXISTS projects(
  slug TEXT PRIMARY KEY,
  name TEXT, description TEXT, genre TEXT, tags TEXT,
  status TEXT DEFAULT '评估中',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT,
  latest_eval TEXT
);
CREATE TABLE IF NOT EXISTS evaluations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug TEXT, version INTEGER,
  scores TEXT, dev_time TEXT, window TEXT, report TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  meta TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evals ON evaluations(project_slug, id);
CREATE TABLE IF NOT EXISTS conversations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT, role TEXT, content TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  meta TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_convs ON conversations(session, id);
CREATE TABLE IF NOT EXISTS feedback(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT, ref_id TEXT, rating INTEGER, comment TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS research_queue(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT, status TEXT DEFAULT 'pending', priority REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now','localtime')), done_at TEXT
);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`);

export const stmtAll = (sql, params = []) => db.prepare(sql).all(...params);
export const stmtGet = (sql, params = []) => db.prepare(sql).get(...params);
export const stmtRun = (sql, params = []) => db.prepare(sql).run(...params);

// ---------- insights ----------
export function addInsight({ content, category = '通用', tags = '', sourceType = null, sourceRef = null, url = null, weight = 1, meta = {} }) {
  const r = stmtRun(
    `INSERT INTO insights(content, category, tags, source_type, source_ref, url, weight, meta) VALUES(?,?,?,?,?,?,?,?)`,
    [content, category, tags, sourceType, sourceRef, url, weight, JSON.stringify(meta)]
  );
  return Number(r.lastInsertRowid);
}

export function listInsights({ category = null, limit = 100, offset = 0 } = {}) {
  if (category) return stmtAll(`SELECT * FROM insights WHERE category=? ORDER BY id DESC LIMIT ? OFFSET ?`, [category, limit, offset]);
  return stmtAll(`SELECT * FROM insights ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, offset]);
}

// ---------- sources ----------
export function upsertSource(type, ref, { title = '', url = '', raw = null }) {
  stmtRun(
    `INSERT INTO sources(type, ref, title, url, fetched_at, raw) VALUES(?,?,?,?,?,?)
     ON CONFLICT(type, ref) DO UPDATE SET title=excluded.title, url=excluded.url, fetched_at=excluded.fetched_at, raw=excluded.raw`,
    [type, ref, title, url, localNow(), raw === null ? null : JSON.stringify(raw)]
  );
}

export function sourceExists(type, ref) { return Boolean(stmtGet(`SELECT 1 AS x FROM sources WHERE type=? AND ref=?`, [type, ref])); }

export function countSources() { return stmtGet(`SELECT COUNT(*) AS n FROM sources`).n; }

// ---------- snapshots ----------
export function addSnapshot(kind, payload) {
  const r = stmtRun(`INSERT INTO snapshots(kind, payload) VALUES(?,?)`, [kind, JSON.stringify(payload)]);
  return Number(r.lastInsertRowid);
}
export function getLatestSnapshot(kind) {
  const row = stmtGet(`SELECT * FROM snapshots WHERE kind=? ORDER BY id DESC LIMIT 1`, [kind]);
  return row ? { id: row.id, created_at: row.created_at, payload: JSON.parse(row.payload) } : null;
}

// ---------- projects / evaluations ----------
export function upsertProject({ slug, name, description = '', genre = '', tags = '', status = '评估中' }) {
  stmtRun(
    `INSERT INTO projects(slug, name, description, genre, tags, status, updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, genre=excluded.genre, tags=excluded.tags, status=excluded.status, updated_at=excluded.updated_at`,
    [slug, name, description, genre, tags, status, localNow()]
  );
}

export function getProject(slug) { return stmtGet(`SELECT * FROM projects WHERE slug=?`, [slug]); }
export function listProjects() { return stmtAll(`SELECT * FROM projects ORDER BY updated_at DESC, created_at DESC LIMIT 100`); }

export function addEvaluation({ projectSlug, version = 1, scores = {}, devTime = {}, window = {}, report = '', meta = {} }) {
  const r = stmtRun(
    `INSERT INTO evaluations(project_slug, version, scores, dev_time, window, report, meta) VALUES(?,?,?,?,?,?,?)`,
    [projectSlug, version, JSON.stringify(scores), JSON.stringify(devTime), JSON.stringify(window), report, JSON.stringify(meta)]
  );
  stmtRun(`UPDATE projects SET latest_eval=?, updated_at=? WHERE slug=?`, [report, localNow(), projectSlug]);
  return Number(r.lastInsertRowid);
}

export function listEvaluations(slug, limit = 10) {
  return stmtAll(`SELECT * FROM evaluations WHERE project_slug=? ORDER BY id DESC LIMIT ?`, [slug, limit]);
}

// ---------- conversations ----------
export function addConv(session, role, content, meta = {}) {
  const r = stmtRun(`INSERT INTO conversations(session, role, content, meta) VALUES(?,?,?,?)`, [session, role, content, JSON.stringify(meta)]);
  return Number(r.lastInsertRowid);
}

export function recentConvs(session, limit = 24) {
  return stmtAll(`SELECT * FROM conversations WHERE session=? ORDER BY id DESC LIMIT ?`, [session, limit]).reverse();
}

/** 会话列表（标题取该会话第一条用户消息） */
export function listSessions(limit = 50) {
  return stmtAll(
    `SELECT session,
            COUNT(*) AS n,
            MIN(created_at) AS first_at,
            MAX(created_at) AS last_at,
            (SELECT content FROM conversations c2 WHERE c2.session = c.session AND c2.role='user' ORDER BY c2.id ASC LIMIT 1) AS title
     FROM conversations c
     GROUP BY session ORDER BY last_at DESC LIMIT ?`,
    [limit]
  );
}

/** 项目最近一次评估的 meta（含 session 关联） */
export function latestEvalMeta(slug) {
  const row = stmtGet(`SELECT meta FROM evaluations WHERE project_slug=? ORDER BY id DESC LIMIT 1`, [slug]);
  return row ? safeJsonParse(row.meta, {}) : {};
}

/** 删除会话及其全部对话记录 */
export function deleteSession(session) {
  stmtRun(`DELETE FROM conversations WHERE session=?`, [session]);
}

/** 删除项目档案：项目 + 评估记录 + 关联的评估洞察（对话保留） */
export function deleteProject(slug) {
  stmtRun(`DELETE FROM projects WHERE slug=?`, [slug]);
  stmtRun(`DELETE FROM evaluations WHERE project_slug=?`, [slug]);
  stmtRun(`DELETE FROM insights WHERE category='项目评估' AND source_ref=?`, [slug]);
}

// ---------- feedback ----------
export function addFeedback(kind, refId, rating, comment = '') {
  stmtRun(`INSERT INTO feedback(kind, ref_id, rating, comment) VALUES(?,?,?,?)`, [kind, String(refId), rating, comment]);
}

// ---------- research queue ----------
export function addQueue(question, priority = 1) {
  stmtRun(`INSERT INTO research_queue(question, priority) VALUES(?,?)`, [question, priority]);
}
export function takeQueue(limit = 1) {
  return stmtAll(`SELECT * FROM research_queue WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT ?`, [limit]);
}
export function markQueueDone(id) {
  stmtRun(`UPDATE research_queue SET status='done', done_at=? WHERE id=?`, [localNow(), id]);
}

// ---------- meta ----------
export function getMeta(k, d = null) {
  const r = stmtGet(`SELECT v FROM meta WHERE k=?`, [k]);
  return r ? r.v : d;
}
export function setMeta(k, v) {
  stmtRun(`INSERT INTO meta(k, v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, String(v)]);
}

// ---------- stats ----------
export function counts() {
  const one = (sql) => stmtGet(sql).n;
  return {
    insights: one(`SELECT COUNT(*) AS n FROM insights`),
    sources: one(`SELECT COUNT(*) AS n FROM sources`),
    projects: one(`SELECT COUNT(*) AS n FROM projects`),
    evaluations: one(`SELECT COUNT(*) AS n FROM evaluations`),
    conversations: one(`SELECT COUNT(*) AS n FROM conversations`),
    queuePending: one(`SELECT COUNT(*) AS n FROM research_queue WHERE status='pending'`),
    lastDigest: getMeta('last_digest', null),
  };
}

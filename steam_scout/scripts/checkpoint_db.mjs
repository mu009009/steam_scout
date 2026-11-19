// 打包前将 SQLite WAL 合并进主库，确保分享的 scout.db 包含最新数据
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root, 'data', 'scout.db'));
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const n = db.prepare('SELECT COUNT(*) AS n FROM insights').get().n;
db.close();
console.log(`WAL 已合并进主库，主库洞察数: ${n}`);

// 分享包脱敏：清除对话/反馈/项目档案等私人数据，保留知识库（UP主观点/市场数据/复盘）
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2]);
db.exec(`
DELETE FROM conversations;
DELETE FROM feedback;
DELETE FROM projects;
DELETE FROM evaluations;
DELETE FROM insights WHERE category IN ('项目评估','调研结论');
PRAGMA wal_checkpoint(TRUNCATE);
`);
const n = db.prepare(`SELECT COUNT(*) AS n FROM insights`).get().n;
db.close();
console.log(`分享包已脱敏：清除对话/反馈/项目档案，保留 ${n} 条知识库洞察`);

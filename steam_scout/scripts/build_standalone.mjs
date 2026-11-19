// 构建单文件版 index.html：内联 样式 + 应用逻辑 + 规则评估引擎 + 内置知识库 + 系统提示词
// 用法：node scripts/build_standalone.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 1) 规则评估引擎（去掉 ESM import/export，注入工具函数）
let evalSrc = read('src/evaluator.mjs')
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/export\s+(function|const)/g, '$1');
const evalShim = `
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const localNow = () => new Date().toLocaleString('zh-CN', { hour12: false });
${evalSrc}
window.EVAL = { estimateDevTime, scoreMarket, assessWindow, buildReport };
`;

// 2) 系统提示词
const agentSrc = read('src/agent.mjs');
const promptMatch = agentSrc.match(/export const SYSTEM_PROMPT = `([\s\S]*?)`;\s*\n/);
if (!promptMatch) throw new Error('未能从 src/agent.mjs 提取 SYSTEM_PROMPT');
const systemPrompt = promptMatch[1];

// 3) 内置知识库（排除个人项目评估，保留方法论/调研结论/复盘/市场数据）
const db = new DatabaseSync(path.join(ROOT, 'data', 'scout.db'));
const rows = db
  .prepare(`SELECT content, category, tags, url FROM insights WHERE category <> '项目评估' ORDER BY weight DESC, id ASC LIMIT 400`)
  .all();
db.close();
const seedKb = rows.map((r) => ({ content: r.content, category: r.category, tags: r.tags || '', url: r.url || '' }));

// 4) 应用逻辑
const appSrc = read('web/standalone-app.js');

const CSS = `
:root{--bg:#0f1218;--bg2:#161b26;--bg3:#1d2433;--border:#2a3348;--text:#dde3ee;--muted:#8b94a7;--accent:#4c8dff;--accent2:#38d996;--warn:#f0b429;--danger:#ef5f6b}
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;font-size:15px;display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:var(--bg2);border-bottom:1px solid var(--border);flex-wrap:wrap}
.brand{font-size:17px}.brand .sub{color:var(--muted);font-size:12px;margin-left:6px}
.badges{display:flex;gap:8px;align-items:center}
.badge{font-size:12px;padding:4px 10px;border-radius:20px;border:1px solid var(--border);background:var(--bg3);color:var(--muted);cursor:default}
.badge.ok{color:var(--accent2);border-color:#2f6b52}.badge.warn{color:var(--warn);border-color:#6b5a2a}.badge.bad{color:var(--danger);border-color:#6b3038;cursor:pointer}
main{flex:1;display:flex;flex-direction:column;min-height:0;max-width:1080px;width:100%;margin:0 auto;padding:0 16px}
.note{font-size:12px;color:var(--muted);padding:8px 4px 0}
.panel{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:10px 0}
.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.panel-head button{background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer}
.hint-txt{font-size:12px;color:var(--muted);line-height:1.6}
.panel label{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}
.panel input{width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit}
.panel input:focus{border-color:var(--accent)}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.row button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer}
.row button.ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
#kb-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 4px;flex-wrap:wrap}
#kb-stats{font-size:12px;color:var(--muted)}
.mini{background:var(--bg3);border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.mini:hover{color:var(--accent);border-color:var(--accent)}
#kb-box{max-height:200px;overflow-y:auto;margin:0 0 8px}
.kb-item{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:7px 10px;margin:4px 0;font-size:12.5px;color:var(--text);line-height:1.6}
.kb-cat{color:var(--accent2);font-size:11px;margin-right:6px}
#messages{flex:1;overflow-y:auto;padding:14px 4px;display:flex;flex-direction:column;gap:14px}
.msg{display:flex}.msg.user{justify-content:flex-end}
.bubble{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:12px 16px;max-width:92%;line-height:1.7;word-break:break-word}
.msg.user .bubble{background:#24344f;border-color:#33476b;max-width:80%}
.bubble h1{font-size:19px;border-bottom:1px solid var(--border);padding-bottom:6px;margin:12px 0 8px}
.bubble h2{font-size:16px;margin:14px 0 8px}.bubble h3{font-size:14px;margin:12px 0 6px}
.bubble p{margin:6px 0}.bubble ul,.bubble ol{margin:6px 0 6px 20px}
.bubble table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px}
.bubble th,.bubble td{border:1px solid var(--border);padding:6px 9px;text-align:left}.bubble th{background:var(--bg2)}
.bubble code{background:var(--bg2);border-radius:4px;padding:1px 5px;font-family:Consolas,monospace;font-size:13px}
.bubble pre{background:#0a0d13;border:1px solid var(--border);border-radius:8px;padding:10px;overflow-x:auto;margin:8px 0}
.bubble blockquote{border-left:3px solid var(--accent);background:var(--bg2);padding:6px 12px;margin:8px 0;color:var(--muted)}
.bubble hr{border:none;border-top:1px solid var(--border);margin:10px 0}
.statusline{font-size:12.5px;color:var(--muted);padding:4px 2px 0}
.pulse{animation:pulse-op 1.2s ease-in-out infinite}
@keyframes pulse-op{0%,100%{opacity:.45}50%{opacity:1}}
.err{color:var(--danger)}
#chips{display:flex;gap:8px;flex-wrap:wrap;padding:6px 0}
.chip{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:16px;padding:6px 12px;font-size:12.5px;cursor:pointer}
.chip:hover{border-color:var(--accent)}
#composer{display:flex;gap:10px;align-items:flex-end;padding:10px 0 16px}
#input{flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:12px;padding:11px 14px;font-size:14px;font-family:inherit;resize:none;max-height:160px;outline:none}
#input:focus{border-color:var(--accent)}
#send{width:46px;height:46px;border-radius:12px;border:none;background:var(--accent);color:#fff;font-size:18px;cursor:pointer}
#send:disabled{opacity:.5;cursor:not-allowed}
.hidden{display:none}
#toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1d2a44;border:1px solid var(--accent);color:#d9e8ff;padding:10px 18px;border-radius:10px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none}
#toast.show{opacity:1}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Steam 市场侦察兵 · 单文件版</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand">🎯 <b>Steam 市场侦察兵</b><span class="sub">单文件版 · 双击即用 · 无需安装</span></div>
  <div class="badges">
    <span id="mode-badge" class="badge warn">…</span>
    <span id="llm-badge" class="badge bad">…</span>
  </div>
</header>
<main>
  <div id="server-note" class="note"></div>
  <div id="cfg-panel" class="panel hidden">
    <div class="panel-head"><b>⚙️ 配置 LLM API</b><button id="cfg-close">✕</button></div>
    <p class="hint-txt">只需填一个 <b>OpenAI 兼容</b>的大模型 Key（推荐 DeepSeek，注册即有额度）。Key 只保存在本机浏览器 localStorage，不会上传；Steam/B站/搜索均无需任何 Key。</p>
    <label>API Key<input id="cfg-key" type="password" placeholder="sk-…" autocomplete="off"></label>
    <label>服务地址 Base URL<input id="cfg-base" placeholder="https://api.deepseek.com"></label>
    <label>模型名<input id="cfg-model" placeholder="deepseek-chat / deepseek-flash / gpt-4o-mini"></label>
    <div class="row"><button id="cfg-save">保存</button><button id="cfg-test" class="ghost">保存并测试</button></div>
    <div id="cfg-result" class="hint-txt" style="margin-top:8px"></div>
  </div>
  <div id="kb-bar">
    <span id="kb-stats"></span>
    <button id="btn-kb" class="mini">🔍 搜本地知识库</button>
  </div>
  <div id="kb-box" class="hidden"></div>
  <div id="messages"></div>
  <div id="chips">
    <button class="chip" data-q="评估立项：《XXX》2D 肉鸽卡牌，2人团队，计划12个月上线——值不值得做？">① 📊 评估我的项目</button>
    <button class="chip" data-q="2026 年哪些 Steam 品类处于上升期？适合小团队进场？">📈 哪些品类在上升期？</button>
    <button class="chip" data-q="幸存者like 现在还能进场吗？做多久上线比较合适？">⚔️ 幸存者like 还能做吗？</button>
    <button class="chip" data-q="为什么《Friendslop》2天卖100万又快速降温？小团队能学到什么？">🐟 Friendslop 案例复盘</button>
  </div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="描述你的游戏立项想法，或问任何 Steam 市场问题…（Enter 发送，Shift+Enter 换行）"></textarea>
    <button id="send">➤</button>
  </div>
</main>
<div id="toast"></div>
<script>window.SEED_KB = ${JSON.stringify(seedKb)};</script>
<script>window.SYSTEM_PROMPT = ${JSON.stringify(systemPrompt)};</script>
<script>${evalShim}</script>
<script>${appSrc}</script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html, 'utf8');
const size = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`✅ 已生成单文件版 index.html（${size} KB）`);
console.log(`   内置知识库 ${seedKb.length} 条 | 系统提示词 ${systemPrompt.length} 字 | 含规则评估引擎`);

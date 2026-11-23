// 本地 HTTP 服务：SSE 流式聊天 + 静态 Web UI + 管理接口
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, saveEnvFile } from './src/config.mjs';
import { runChat } from './src/agent.mjs';
import { llmConfigured, chat } from './src/llm.mjs';
import * as db from './src/db.mjs';
import { safeJsonParse } from './src/util.mjs';
import { dataInventory } from './src/inventory.mjs';
import { dataProviderStatus, providerGameStats, PRESETS } from './src/tools/paid-data.mjs';
import { startScheduler, runDigest } from './src/evolution.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(b),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(b);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const p = path.normalize(path.join(CONFIG.webDir, rel));
  if (!p.startsWith(CONFIG.webDir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
}

async function handleChat(req, res) {
  const { session = 'default', message = '', mode = null } = await readBody(req);
  if (!message || !String(message).trim()) { sendJson(res, 400, { error: 'message 不能为空' }); return; }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
  req.socket.setTimeout(0);
  const emit = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  emit({ type: 'start' });
  try {
    await runChat({ session, message: String(message).trim(), mode, emit });
  } catch (e) {
    emit({ type: 'error', message: String(e.message || e) });
  }
  try { res.end(); } catch {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // CORS 预检（单文件 HTML 以 file:// 打开时也能调用本地服务）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    return res.end();
  }
  try {
    if (p === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (p === '/api/history') {
      const session = url.searchParams.get('session') || 'default';
      const messages = db.recentConvs(session, 60).map((m) => ({ ...m, meta: safeJsonParse(m.meta, {}) }));
      return sendJson(res, 200, { messages });
    }
    if (p === '/api/sessions') return sendJson(res, 200, { sessions: db.listSessions() });
    if (p === '/api/stats') return sendJson(res, 200, { llm: llmConfigured(), counts: db.counts(), config: { upMid: CONFIG.upMid, port: CONFIG.port } });
    if (p === '/api/projects') {
      const projects = db.listProjects().map((proj) => ({
        slug: proj.slug,
        name: proj.name,
        genre: proj.genre,
        status: proj.status,
        created_at: proj.created_at,
        session: db.latestEvalMeta(proj.slug)?.session ?? null,
        report: proj.latest_eval ?? '',
      }));
      return sendJson(res, 200, { projects });
    }
    if (p === '/api/digests') return sendJson(res, 200, { items: db.listInsights({ category: '复盘报告', limit: 10 }), recent: db.listInsights({ limit: 10 }) });
    if (p === '/api/data-inventory') return sendJson(res, 200, dataInventory());
    if (p === '/api/delete-session' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.session) return sendJson(res, 400, { error: '缺少 session' });
      db.deleteSession(String(b.session));
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/delete-project' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.slug) return sendJson(res, 400, { error: '缺少 slug' });
      db.deleteProject(String(b.slug));
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/feedback' && req.method === 'POST') {
      const b = await readBody(req);
      db.addFeedback(b.kind || 'answer', b.refId, Number(b.rating) || 0, b.comment || '');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/digest-now' && req.method === 'POST') {
      runDigest({ force: true, log: console.log }).catch((e) => console.error('[digest-now]', e.message));
      return sendJson(res, 202, { ok: true, note: '复盘任务已在后台启动' });
    }
    if (p === '/api/health') return sendJson(res, 200, { ok: true, llm: llmConfigured(), dataProvider: dataProviderStatus().provider });
    if (p === '/api/data-provider') {
      const st = dataProviderStatus();
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ...st,
          presets: Object.entries(PRESETS).map(([id, v]) => ({
            id,
            label: v.label,
            free: Boolean(v.free),
            urlTemplate: v.base,
            keyParam: v.keyParam ?? '',
            howto: v.howto ?? '',
            signup: v.signup ?? '',
            needsKey: !v.free && id !== 'custom',
          })),
        });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const provider = String(b.provider ?? '').trim().toLowerCase();
        const apiKey = String(b.apiKey ?? '').trim();
        const urlTemplate = String(b.urlTemplate ?? '').trim();
        const fieldMapRaw = String(b.fieldMap ?? '').trim();
        if (provider && !PRESETS[provider]) return sendJson(res, 400, { ok: false, error: `未知数据源：${provider}（可选 ${Object.keys(PRESETS).join(' / ')}）` });
        if (provider && PRESETS[provider] && !PRESETS[provider].base && !/^https?:\/\//i.test(urlTemplate)) {
          return sendJson(res, 400, { ok: false, error: '自定义数据源需要填写 URL 模板（含 {appid} 占位符）' });
        }
        if (urlTemplate && !/^https?:\/\//i.test(urlTemplate)) return sendJson(res, 400, { ok: false, error: 'URL 模板需以 http:// 或 https:// 开头' });
        if (fieldMapRaw) {
          try { JSON.parse(fieldMapRaw); } catch { return sendJson(res, 400, { ok: false, error: '字段映射需为合法 JSON，例如 {"reviews":"reviews.total","owners":"owners"}' }); }
        }
        if (provider && provider !== 'custom' && !apiKey && !PRESETS[provider].free && !CONFIG.data.apiKey) {
          return sendJson(res, 400, { ok: false, error: `${PRESETS[provider].label} 需要 API Key` });
        }
        const prev = { ...CONFIG.data };
        CONFIG.data.provider = provider;
        CONFIG.data.apiKey = apiKey || (provider === prev.provider ? prev.apiKey : '') || (PRESETS[provider]?.free ? '' : prev.apiKey);
        CONFIG.data.urlTemplate = urlTemplate;
        CONFIG.data.fieldMap = fieldMapRaw;
        let test = null;
        if (provider && b.test !== false) {
          const notes = [];
          const collector = (ev) => { if (ev?.text) notes.push(ev.text); };
          try {
            const s = await providerGameStats({ appid: String(b.testAppid || 413150), name: 'Stardew Valley' }, collector);
            if (s) test = { ok: true, sample: s, notes };
            else {
              const reason = notes.join(' ｜ ') || '数据源没有返回可识别的字段（检查 URL 模板与字段映射）';
              test = { ok: false, error: reason, notes };
              Object.assign(CONFIG.data, prev);
              return sendJson(res, 400, { ok: false, error: `测试失败：${reason}`, test });
            }
          } catch (e) {
            test = { ok: false, error: String(e.message || e).slice(0, 300), notes };
            Object.assign(CONFIG.data, prev);
            return sendJson(res, 400, { ok: false, error: `数据源测试失败：${test.error}`, test });
          }
        }
        try {
          saveEnvFile(path.join(CONFIG.rootDir, '.env'), {
            DATA_PROVIDER: provider,
            DATA_PROVIDER_KEY: CONFIG.data.apiKey || '',
            DATA_PROVIDER_URL: urlTemplate,
            DATA_PROVIDER_MAP: fieldMapRaw,
          });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: `配置已在本次运行生效，但写入 .env 失败：${e.message}` });
        }
        return sendJson(res, 200, { ok: true, ...dataProviderStatus(), test });
      }
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    }
    if (p === '/api/llm-config') {
      const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          configured: llmConfigured(),
          baseUrl: CONFIG.llm.baseUrl,
          model: CONFIG.llm.model,
          apiKeyMasked: mask(CONFIG.llm.apiKey),
        });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const baseUrl = String(b.baseUrl || CONFIG.llm.baseUrl || '').trim().replace(/\/+$/, '');
        const model = String(b.model || CONFIG.llm.model || '').trim();
        const apiKey = String(b.apiKey || '').trim();
        const prev = { baseUrl: CONFIG.llm.baseUrl, model: CONFIG.llm.model, apiKey: CONFIG.llm.apiKey };
        if (!/^https?:\/\//i.test(baseUrl)) return sendJson(res, 400, { ok: false, error: 'Base URL 需以 http:// 或 https:// 开头' });
        if (!model) return sendJson(res, 400, { ok: false, error: '模型名不能为空' });
        const nextKey = apiKey || prev.apiKey;
        if (!nextKey) return sendJson(res, 400, { ok: false, error: '请填写 API Key' });
        // 先运行时生效，再做连通性测试
        CONFIG.llm.baseUrl = baseUrl;
        CONFIG.llm.model = model;
        CONFIG.llm.apiKey = nextKey;
        let test = null;
        if (b.test !== false) {
          try {
            const r = await chat({ messages: [{ role: 'user', content: '只回复两个字母：OK' }], temperature: 0, maxTokens: 24 });
            test = { ok: true, reply: String(r.content || '').slice(0, 40) };
          } catch (e) {
            test = { ok: false, error: String(e.message || e).slice(0, 300) };
            CONFIG.llm.baseUrl = prev.baseUrl;
            CONFIG.llm.model = prev.model;
            CONFIG.llm.apiKey = prev.apiKey;
            return sendJson(res, 400, { ok: false, error: `连通性测试失败：${test.error}`, test });
          }
        }
        // 测试通过（或跳过测试）→ 写入 .env 持久化
        try {
          saveEnvFile(path.join(CONFIG.rootDir, '.env'), {
            DEEPSEEK_API_KEY: nextKey,
            LLM_BASE_URL: baseUrl,
            LLM_MODEL: model,
          });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: `配置已在本次运行生效，但写入 .env 失败：${e.message}` });
        }
        return sendJson(res, 200, { ok: true, configured: true, baseUrl, model, apiKeyMasked: mask(nextKey), test });
      }
      return sendJson(res, 405, { error: 'Method Not Allowed' });
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '接口不存在' });
    if (req.method === 'GET') return serveStatic(res, p);
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${CONFIG.port} 已被占用。新版 start.bat 会自动清理占用后启动——直接双击 start.bat 即可（无需手动改端口）。`);
  } else {
    console.error('服务器错误:', e);
  }
  process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('==============================================');
  console.log('  Steam 市场侦察兵 (SteamScout) 已启动');
  console.log(`  聊天界面: http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  LLM 状态: ${llmConfigured() ? `已配置 (${CONFIG.llm.model})` : '未配置 —— 编辑 .env 设置 DEEPSEEK_API_KEY'}`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('==============================================');
  startScheduler();
});

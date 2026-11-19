import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    let k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) out[k] = v;
  }
  return out;
}

/** 把配置写回 .env（保留注释与其它行；缺失的键追加到末尾） */
export function saveEnvFile(filePath, updates) {
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/) : [];
  const pending = { ...updates };
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(pending, m[1])) {
      const key = m[1];
      const val = String(pending[key]);
      delete pending[key];
      return `${key}=${val}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(pending)) {
    if (v === undefined || v === null || v === '') continue;
    out.push(`${k}=${v}`);
  }
  fs.writeFileSync(filePath, out.join('\r\n'), 'utf8');
}

// .env 覆盖（不覆盖已存在的进程环境变量）
const envFile = loadEnvFile(path.join(ROOT, '.env'));
for (const [k, v] of Object.entries(envFile)) if (!(k in process.env)) process.env[k] = v;

let cfgJson = {};
const cfgPath = path.join(ROOT, 'config.json');
if (fs.existsSync(cfgPath)) { try { cfgJson = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { console.error('[config] config.json 解析失败:', e.message); } }

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

export const CONFIG = {
  rootDir: ROOT,
  webDir: path.join(ROOT, 'web'),
  dataDir: path.join(ROOT, 'data'),
  dbPath: path.join(ROOT, 'data', 'scout.db'),
  host: '127.0.0.1',
  port: Number(env('PORT', cfgJson.port ?? 8792)),
  upMid: String(cfgJson.upMid ?? '3546782527130177'),
  llm: {
    baseUrl: env('LLM_BASE_URL', cfgJson.llm?.baseUrl ?? 'https://api.deepseek.com'),
    apiKey: env('DEEPSEEK_API_KEY', cfgJson.llm?.apiKey ?? ''),
    model: env('LLM_MODEL', cfgJson.llm?.model ?? 'deepseek-chat'),
    temperature: Number(cfgJson.llm?.temperature ?? 0.3),
    maxTokens: Number(cfgJson.llm?.maxTokens ?? 4096),
    timeoutMs: Number(cfgJson.llm?.timeoutMs ?? 180000),
  },
  agent: {
    maxToolRounds: Number(cfgJson.agent?.maxToolRounds ?? 8),
    maxToolCalls: Number(cfgJson.agent?.maxToolCalls ?? 14),
    historyTurns: Number(cfgJson.agent?.historyTurns ?? 12),
  },
  evolution: {
    enabled: cfgJson.evolution?.enabled !== false,
    digestHour: Number(cfgJson.evolution?.digestHour ?? 9),
    intervalHours: Number(cfgJson.evolution?.intervalHours ?? 24),
    autoResearchMaxPerDay: Number(cfgJson.evolution?.autoResearchMaxPerDay ?? 1),
    upSync: cfgJson.evolution?.upSync !== false,
  },
  steam: {
    cc: cfgJson.steam?.cc ?? 'cn',
    l: cfgJson.steam?.l ?? 'schinese',
    maxResults: Number(cfgJson.steam?.maxResults ?? 60),
  },
};

fs.mkdirSync(CONFIG.dataDir, { recursive: true });

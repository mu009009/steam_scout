/* SteamScout 单文件版（双击 index.html 即用）
 * 两种模式：
 *  - 单文件模式：浏览器直连 OpenAI 兼容 LLM（Key 存本地 localStorage）+ 内置知识库 + 规则评估引擎
 *  - 完整模式：自动探测本机服务(127.0.0.1:8792)，可用时走服务端（实时 Steam/B站数据、SQLite 存档）
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const SERVER_BASE = 'http://127.0.0.1:8792';
  const LS_CFG = 'scout_llm_v1';
  const LS_KB = 'scout_kb_v1';
  const LS_HIST = 'scout_hist_v1';

  const state = {
    mode: 'standalone', // standalone | server
    cfg: null,
    kb: [],
    hist: [],
    busy: false,
  };

  // ---------- 工具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const localNow = () => new Date().toLocaleString('zh-CN', { hour12: false });
  function toast(msg) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------- 极简 Markdown 渲染 ----------
  function md(text) {
    const lines = String(text).split('\n');
    let html = '';
    let list = null;
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((x) => `<li>${x}</li>`).join('')}</${list.tag}>`; list = null; } };
    const inline = (t) => {
      t = esc(t);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      return t;
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line.trim())) { flushList(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; } i++; html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue; }
      if (/^\|.*\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        flushList();
        const head = line.trim().split('|').slice(1, -1).map((c) => c.trim());
        let rows = '';
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows += '<tr>' + lines[i].trim().split('|').slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join('') + '</tr>'; i++; }
        html += '<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
        continue;
      }
      const hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { flushList(); const lv = hm[1].length; html += `<h${lv}>${inline(hm[2])}</h${lv}>`; i++; continue; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushList(); html += '<hr>'; i++; continue; }
      if (/^>\s?/.test(line)) { flushList(); const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; } html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>`; continue; }
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) { const tag = ul ? 'ul' : 'ol'; if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; } list.items.push(inline((ul || ol)[1])); i++; continue; }
      if (!line.trim()) { flushList(); i++; continue; }
      flushList();
      html += `<p>${inline(line)}</p>`;
      i++;
    }
    flushList();
    return html;
  }

  // ---------- 知识库（本地） ----------
  function tokenize(text) {
    const t = String(text).toLowerCase();
    const out = [];
    for (const m of t.matchAll(/[a-z0-9][a-z0-9.+-]{1,40}/g)) if (m[0].length >= 2) out.push(m[0]);
    for (const m of t.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const r = m[0];
      for (let i = 0; i < r.length - 1; i++) out.push(r.slice(i, i + 2));
    }
    return out;
  }
  function kbInit() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KB) || 'null');
      if (saved && Array.isArray(saved) && saved.length) { state.kb = saved; return; }
    } catch {}
    state.kb = Array.isArray(window.SEED_KB) ? window.SEED_KB.slice() : [];
    kbSave();
  }
  function kbSave() {
    try { localStorage.setItem(LS_KB, JSON.stringify(state.kb.slice(0, 600))); } catch {}
  }
  function kbSearch(query, limit = 4) {
    const qts = tokenize(query);
    if (!qts.length || !state.kb.length) return [];
    const N = state.kb.length;
    const df = {};
    const docs = state.kb.map((d) => {
      const tf = {};
      for (const t of tokenize(d.content + ' ' + (d.tags || ''))) tf[t] = (tf[t] || 0) + 1;
      return { d, tf, len: Object.values(tf).reduce((a, b) => a + b, 0) || 1 };
    });
    for (const doc of docs) for (const t of Object.keys(doc.tf)) df[t] = (df[t] || 0) + 1;
    const scored = [];
    for (const doc of docs) {
      let s = 0;
      for (const t of qts) if (doc.tf[t]) s += (1 + Math.log(doc.tf[t])) * Math.log(1 + N / ((df[t] || 0) + 1));
      if (s > 0) scored.push({ s: s / Math.sqrt(doc.len), d: doc.d });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.d);
  }

  // ---------- LLM（浏览器直连 OpenAI 兼容接口） ----------
  function loadCfg() {
    try { state.cfg = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch { state.cfg = null; }
    if (!state.cfg) state.cfg = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' };
    $('#cfg-base').value = state.cfg.baseUrl || '';
    $('#cfg-model').value = state.cfg.model || '';
    $('#cfg-key').value = '';
    $('#cfg-key').placeholder = state.cfg.apiKey ? `已保存：${state.cfg.apiKey.slice(0, 6)}…（留空保持不变）` : 'sk-…';
  }
  function saveCfg() {
    const key = $('#cfg-key').value.trim();
    state.cfg = {
      baseUrl: ($('#cfg-base').value.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: $('#cfg-model').value.trim() || 'deepseek-chat',
      apiKey: key || (state.cfg && state.cfg.apiKey) || '',
    };
    localStorage.setItem(LS_CFG, JSON.stringify(state.cfg));
    updateBadges();
    toast('✅ 已保存到本机浏览器（localStorage）');
  }
  const llmReady = () => Boolean(state.cfg && state.cfg.apiKey);
  function cfgSummary() { return `${state.cfg.baseUrl} · ${state.cfg.model}`; }

  async function llmChat(messages, { stream = false, onDelta, temperature = 0.4, maxTokens = 2048 } = {}) {
    if (!llmReady()) throw new Error('未配置 LLM API Key：点右上角「⚙️ 配置」填入你自己的 Key');
    const url = state.cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.cfg.apiKey}` },
      body: JSON.stringify({ model: state.cfg.model, messages, stream, temperature, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const t = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`LLM 请求失败 HTTP ${res.status}：${t}`);
    }
    if (!stream) {
      const j = await res.json();
      return { content: j.choices?.[0]?.message?.content || '' };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices?.[0]?.delta || {};
        if (d.content) { content += d.content; onDelta?.(d.content); }
        if (d.reasoning_content) reasoning += d.reasoning_content;
      }
    }
    if (!content && reasoning) {
      // 推理型模型兜底：非流式重试
      const r2 = await llmChat(messages, { stream: false, temperature, maxTokens });
      return { content: r2.content };
    }
    return { content };
  }

  // ---------- 服务端模式（可选） ----------
  async function detectServer() {
    try {
      const r = await fetch(SERVER_BASE + '/api/health', { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      state.mode = 'server';
      return j;
    } catch {
      state.mode = 'standalone';
      return null;
    }
  }
  async function serverChat(message, onEvent) {
    const res = await fetch(SERVER_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'file-mode', message }),
    });
    if (!res.ok || !res.body) throw new Error('本地服务返回异常 HTTP ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let e;
        try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
        onEvent(e);
      }
    }
  }

  // ---------- 消息渲染 ----------
  const messagesEl = () => $('#messages');
  function addMsg(role) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    messagesEl().appendChild(wrap);
    scrollDown();
    return { wrap, bubble, text: '' };
  }
  const scrollDown = () => { const el = messagesEl(); el.scrollTop = el.scrollHeight; };
  function renderHist() {
    messagesEl().innerHTML = '';
    if (!state.hist.length) { welcome(); return; }
    for (const m of state.hist) {
      const msg = addMsg(m.role);
      msg.bubble.innerHTML = m.role === 'assistant' ? md(m.content) : esc(m.content);
    }
    scrollDown();
  }
  function welcome() {
    const w = addMsg('assistant');
    w.bubble.innerHTML = md(
      `**Steam 市场侦察兵 · 单文件版**\n\n双击即用，无需安装任何东西。功能取决于模式：\n\n` +
      `| 模式 | 状态 | 能做 |\n|---|---|---|\n` +
      `| 📄 单文件 | 当前 | AI 对话分析、内置知识库、开发周期/窗口评估、报告导出 PDF |\n` +
      `| 🔌 完整 | 本机运行 \`start.bat\` 后自动连上 | 追加实时 Steam/B站数据采集、项目档案、自动复盘 |\n\n` +
      `**三步用法**：① 描述游戏想法（含"值不值得做/多久上线"）→ 出评估报告；② 问任何 Steam 市场问题；③ 导出 PDF 或继续追问。\n\n` +
      `> 首次使用请点右上角「⚙️ 配置」填入你自己的 LLM API Key（只存在本机浏览器）。`
    );
  }
  function pushHist(role, content) {
    state.hist.push({ role, content });
    if (state.hist.length > 60) state.hist = state.hist.slice(-60);
    try { localStorage.setItem(LS_HIST, JSON.stringify(state.hist)); } catch {}
  }

  // ---------- 提示词 ----------
  function kbContext(query) {
    const hits = kbSearch(query, 4);
    if (!hits.length) return '';
    return '\n\n【本地知识库摘录（B站 UP 主「Gaby学姐说」方法论 + 历史调研结论）】\n' + hits.map((h, i) => `${i + 1}. [${h.category}] ${h.content}`).join('\n');
  }
  const STANDALONE_NOTE = '\n\n【运行模式】当前为单文件离线模式：**没有实时 Steam/B站数据**。涉及竞品销量/价格/在线人数时，请明确说明是"估计/参考值"，不要编造精确数字；数据不确定就说不确定。开发周期与上线窗口可用引擎规则估算。';

  // ---------- 评估（单文件模式） ----------
  const evalKeywords = /评估|立项|值不值得|能不能做|值多少|做多久|多久.{0,6}(做|完成|开发|上线)|市场潜力|时机|可行性|还能.{0,6}(进场|入场|做)|红海|饱和/;
  const isArchive = /(输出|回顾|查看|读取|导出).{0,12}(项目|档案)/;

  async function standaloneEval(text) {
    const ai = addMsg('assistant');
    const sys = window.SYSTEM_PROMPT + STANDALONE_NOTE;
    ai.bubble.innerHTML = '<p class="pulse">🔎 正在解析项目并做定性评估（单文件模式，无实时数据）…</p>';
    scrollDown();
    let brief = { name: '未命名项目', genre: '', description: text.slice(0, 200), dimension: '2D', scope: '', teamSize: 1, experience: '有经验' };
    try {
      const r = await llmChat([
        { role: 'system', content: '你是游戏立项信息提取助手。从用户描述提取 JSON：{"name","genre","description","dimension","scope","team_size","experience"}。genre 用中文品类名；dimension 填 2D 或 3D；scope 填 小型/中型/大型；team_size 数字；experience 填 新手/有经验/资深。**用户没说品类就把 genre 留空字符串，不要瞎猜。** 只输出 JSON。' },
        { role: 'user', content: text },
      ], { temperature: 0 });
      const j = JSON.parse(String(r.content).replace(/```json|```/g, '').trim());
      brief = { ...brief, ...j, teamSize: Math.max(1, Math.round(Number(j.team_size) || 1)) };
    } catch {}

    // 预检：提到具体游戏名 / 没说品类 → 先问清楚（避免把新游名误判成品类）
    const titles = [...String(text).matchAll(/《([^》]{2,40})》/g)].map((m) => m[1]);
    const genreKnown = /肉鸽|卡牌|生存|模拟|经营|平台|跳跃|塔防|解谜|视觉小说|放置|挂机|沙盒|物理|动作|恐怖|钓鱼|多人|开放世界|射击|策略|养成|战棋|tcg|dbg|卡组/i.test(brief.genre || '');
    if (!genreKnown || titles.length) {
      state.pendingClarify = true;
      const lines = [
        '## 需要先确认一下（避免把品类判断错）',
        titles.length
          ? `你提到的 ${titles.map((t) => `《${t}》`).join('、')} 是**具体游戏名**，我需要知道它的品类才能给对市场数据（单文件模式查不到 Steam，所以直接问你）。`
          : '我没从描述里识别出明确的**品类**，为了给对赛道数据，先跟你核对。',
        '',
        '**这款游戏的品类是？**（直接回复，或带上团队/周期）',
        '',
        '`肉鸽卡牌` ｜ `幸存者like` ｜ `模拟经营` ｜ `2D 平台跳跃` ｜ `放置挂机` ｜ `塔防` ｜ `沙盒物理` ｜ `视觉小说` ｜ `3D 动作` ｜ `解谜`',
        '',
        '> 补一句就够，例如：「品类：肉鸽卡牌，2D，2人团队，计划12个月上线」。',
      ];
      ai.bubble.innerHTML = md(lines.join('\n'));
      const row = document.createElement('div');
      row.className = 'row';
      for (const g of ['肉鸽卡牌', '幸存者like', '模拟经营', '2D 平台跳跃']) {
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = '🏷️ ' + g;
        b.onclick = () => { $('#input').value = `品类：${g}`; $('#input').focus(); };
        row.appendChild(b);
      }
      ai.bubble.appendChild(row);
      pushHist('user', text);
      pushHist('assistant', lines.join('\n'));
      scrollDown();
      return;
    }
    state.pendingClarify = false;
    // 规则引擎：工期（纯规则，可靠）
    const dev = window.EVAL.estimateDevTime(brief);
    // LLM：市场定性评分（无实时数据，明确标注）
    ai.bubble.innerHTML = '<p class="pulse">📊 正在生成六维市场评估与专家解读…</p>';
    let marketLLM = null;
    try {
      const r = await llmChat([
        { role: 'system', content: sys + kbContext(text) + '\n\n【任务】基于你的知识与本地知识库，对该项目的 Steam 市场给出**定性**六维评估。只输出 JSON：{"dims":[{"name":"需求规模|竞争强度|增长趋势|商业化空间|平台匹配度|差异化空间","score":0-100,"detail":"依据(注明是估计)"}],"momentum":"rising|flat|declining|hype","upcoming_count":估计数字,"competitors":[{"name":"","price":数字,"reviews":估计,"positive_pct":估计,"release_year":估计}],"notes":"数据可信度说明"}' },
        { role: 'user', content: JSON.stringify({ brief, description: text }) },
      ], { temperature: 0.3, maxTokens: 1600 });
      marketLLM = JSON.parse(String(r.content).replace(/```json|```/g, '').trim());
    } catch (e) {
      marketLLM = null;
    }
    const W = { 需求规模: 25, 竞争强度: 20, 增长趋势: 20, 商业化空间: 15, 平台匹配度: 10, 差异化空间: 10 };
    const dims = (marketLLM?.dims || []).map((d) => ({
      name: d.name, weight: W[d.name] ?? 10, score: clamp(Number(d.score) || 50, 0, 100),
      detail: String(d.detail || '（估计值）'),
      status: 'partial', gaps: ['实时 Steam 数据（单文件模式未采集）'],
    }));
    if (!dims.length) {
      // LLM 失败时用中性分兜底
      for (const [name, w] of Object.entries(W)) dims.push({ name, weight: w, score: 50, detail: '未能获取评估结果（LLM 未响应）', status: 'no-data', gaps: ['LLM 评估失败'] });
    }
    const total = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / 100);
    const letter = total >= 85 ? 'S' : total >= 70 ? 'A' : total >= 55 ? 'B' : total >= 40 ? 'C' : 'D';
    const completeness = Math.min(70, Math.round((dims.filter((d) => d.status !== 'no-data').length / 6) * 70));
    const market = {
      total, letter, dims, completeness,
      momentum: marketLLM?.momentum || 'flat',
      upcomingCount: marketLLM?.upcoming_count ?? null,
      releasesByYear: {}, hype: marketLLM?.momentum === 'hype',
    };
    const win = window.EVAL.assessWindow({ devMonthsExpected: dev.months.expected, market });
    const report = window.EVAL.buildReport(
      { ...brief, teamSize: brief.teamSize, experience: brief.experience },
      dev, market, win
    );
    const head = `> ⚠️ **单文件模式**：本报告无实时 Steam 数据，市场评分为 AI 定性估计（工期与窗口为规则引擎计算）。想要真实数据 → 本机运行 \`start.bat\` 后刷新本页，切到「🔌 完整模式」。\n\n`;
    ai.bubble.innerHTML = md(head + report) + '<div class="row"><button class="mini" data-act="pdf">⤓ 导出 PDF</button></div>';
    ai.wrap.querySelector('button[data-act="pdf"]').onclick = () => exportPDF(`${brief.name} 立项评估报告`, head + report);
    const summary = `## 评估完成\n\n- 市场潜力（定性估计）：**${total}/100（${letter}）**\n- 基准工期：**${dev.months.expected} 个月**（乐观 ${dev.months.optimistic} / 悲观 ${dev.months.pessimistic}）\n- 上线窗口：**${win.rating}**（预计 ${win.windowLenMonths} 个月窗口，上线约 ${win.launchDate}）\n- 评分可信度：${completeness}%（无实时数据，偏低）\n\n> 需要真实数据版报告 → 运行 \`start.bat\` 后刷新页面。`;
    pushHist('user', text);
    pushHist('assistant', summary);
    scrollDown();
    return summary;
  }

  // ---------- 聊天（单文件模式） ----------
  async function standaloneChat(text) {
    const ai = addMsg('assistant');
    ai.bubble.innerHTML = '<p class="pulse">💭 正在思考…</p>';
    const sys = window.SYSTEM_PROMPT + (state.mode === 'standalone' ? STANDALONE_NOTE : '');
    const msgs = [{ role: 'system', content: sys + kbContext(text) }];
    for (const h of state.hist.slice(-8)) msgs.push({ role: h.role, content: h.content });
    msgs.push({ role: 'user', content: text });
    let acc = '';
    try {
      const r = await llmChat(msgs, {
        stream: true,
        onDelta: (d) => {
          acc += d;
          ai.bubble.innerHTML = (kbSearch(text, 3).length ? '' : '') + md(acc);
          scrollDown();
        },
      });
      if (!acc) acc = r.content;
      ai.bubble.innerHTML = md(acc) + '<div class="row"><button class="mini" data-act="pdf">⤓ 导出 PDF</button></div>';
      const btn = ai.wrap.querySelector('button[data-act="pdf"]');
      if (btn) btn.onclick = () => exportPDF(extractTitle(acc), acc);
      pushHist('user', text);
      pushHist('assistant', acc);
    } catch (e) {
      ai.bubble.innerHTML = `<p class="err">❌ ${esc(String(e.message || e))}</p>`;
    }
    scrollDown();
  }

  // ---------- 服务端模式 ----------
  async function serverModeChat(text) {
    const ai = addMsg('assistant');
    let status = null;
    let acc = '';
    const ensureStatus = (t) => {
      if (!status) { status = document.createElement('div'); status.className = 'statusline'; ai.wrap.insertBefore(status, ai.bubble); }
      status.textContent = t;
    };
    try {
      await serverChat(text, (e) => {
        if (e.type === 'phase') ensureStatus(`📊 第 ${e.index}/${e.total} 步：${e.text}`);
        else if (e.type === 'status') ensureStatus(e.text);
        else if (e.type === 'tool') ensureStatus(`🔧 ${e.name} ${e.status === 'end' ? '✓' : e.status === 'error' ? '✗' : '…'}`);
        else if (e.type === 'delta') { acc += e.text; ai.bubble.innerHTML = md(acc); scrollDown(); }
        else if (e.type === 'report') { acc = e.text + '\n\n' + acc; ai.bubble.innerHTML = md(acc); scrollDown(); }
        else if (e.type === 'error') { ai.bubble.innerHTML = `<p class="err">❌ ${esc(e.message)}</p>`; }
      });
      if (status) status.remove();
      if (!acc) ai.bubble.innerHTML = '<p>（本轮模型没有输出正文，可能只输出了思考过程或不支持该请求。请重发一次，或换成更具体的提问。）</p>';
      else {
        ai.bubble.innerHTML = md(acc) + '<div class="row"><button class="mini" data-act="pdf">⤓ 导出 PDF</button></div>';
        const btn = ai.wrap.querySelector('button[data-act="pdf"]');
        if (btn) btn.onclick = () => exportPDF(extractTitle(acc), acc);
      }
    } catch (e) {
      if (status) status.remove();
      ai.bubble.innerHTML = `<p class="err">❌ 本地服务调用失败：${esc(String(e.message || e))}。请确认已运行 start.bat。</p>`;
    }
    scrollDown();
  }

  // ---------- PDF 导出 ----------
  const extractTitle = (t) => { const m = String(t).match(/^#\s*《([^》\n]+)》/); return m ? `${m[1]} 立项评估报告` : 'SteamScout 报告'; };
  function exportPDF(title, markdown) {
    const w = window.open('', '_blank');
    if (!w) { toast('浏览器拦截了弹窗，请允许后重试'); return; }
    w.document.open();
    w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;color:#111;background:#fff;margin:0;padding:40px 48px;font-size:13px;line-height:1.75}
h1{font-size:20px;border-bottom:2px solid #222;padding-bottom:8px}h2{font-size:16px;margin:18px 0 8px}h3{font-size:14px;margin:14px 0 6px}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:12.5px}th,td{border:1px solid #999;padding:6px 8px;text-align:left}th{background:#f0f0f0}
blockquote{border-left:3px solid #666;background:#f7f7f7;padding:6px 12px;margin:8px 0;color:#444}code{background:#f2f2f2;padding:1px 5px}
.footer{margin-top:26px;color:#888;font-size:11px;border-top:1px solid #ccc;padding-top:8px}@media print{body{padding:10mm 12mm}}</style>
</head><body>${md(markdown)}<div class="footer">由 Steam 市场侦察兵生成 · 数据来源：AI 知识与本地方法论知识库（单文件模式无实时数据）</div>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),350));<\/script></body></html>`);
    w.document.close();
  }

  // ---------- 发送入口 ----------
  async function send(text) {
    if (state.busy || !String(text).trim()) return;
    text = String(text).trim();
    state.busy = true;
    $('#send').disabled = true;
    const user = addMsg('user');
    user.bubble.textContent = text;
    try {
      if (state.mode === 'server') await serverModeChat(text);
      else if (state.pendingClarify) await standaloneEval(text);
      else if (evalKeywords.test(text) && !isArchive.test(text)) await standaloneEval(text);
      else await standaloneChat(text);
    } finally {
      state.busy = false;
      $('#send').disabled = false;
    }
  }

  // ---------- 配置区 ----------
  function updateBadges() {
    const m = $('#mode-badge');
    const l = $('#llm-badge');
    m.textContent = state.mode === 'server' ? '🔌 完整模式（已连接本地服务）' : '📄 单文件模式（无实时数据）';
    m.className = 'badge ' + (state.mode === 'server' ? 'ok' : 'warn');
    l.textContent = llmReady() ? `🤖 LLM 已配置（${state.cfg.model}）` : '🤖 LLM 未配置 · 点⚙️填写';
    l.className = 'badge ' + (llmReady() ? 'ok' : 'bad');
    l.onclick = () => $('#cfg-panel').classList.toggle('hidden');
  }

  async function init() {
    kbInit();
    loadCfg();
    try {
      const h = JSON.parse(localStorage.getItem(LS_HIST) || '[]');
      state.hist = Array.isArray(h) ? h : [];
    } catch { state.hist = []; }
    const srv = await detectServer();
    updateBadges();
    if (srv && srv.llm) $('#server-note').textContent = '已连上本机服务，实时数据与项目档案可用。';
    else if (srv) $('#server-note').textContent = '已连上本机服务，但服务端未配置 LLM。';
    renderHist();
    if (!llmReady() && !srv) $('#cfg-panel').classList.remove('hidden');
    if (state.mode === 'standalone') kbStats();
  }

  function kbStats() {
    const n = state.kb.length;
    const cats = {};
    for (const k of state.kb) cats[k.category || '其他'] = (cats[k.category || '其他'] || 0) + 1;
    $('#kb-stats').textContent = `📚 本地知识库：${n} 条（${Object.entries(cats).map(([c, v]) => `${c}${v}`).join(' / ')}）`;
  }

  // ---------- 事件绑定 ----------
  $('#send').onclick = () => { const v = $('#input').value; $('#input').value = ''; $('#input').style.height = 'auto'; send(v); };
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send').click(); }
  });
  $('#input').addEventListener('input', () => {
    const el = $('#input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  });
  $('#cfg-save').onclick = () => { saveCfg(); $('#cfg-panel').classList.add('hidden'); };
  $('#cfg-test').onclick = async () => {
    saveCfg();
    $('#cfg-result').textContent = '正在测试…';
    try {
      const r = await llmChat([{ role: 'user', content: '只回复两个字母：OK' }], { temperature: 0, maxTokens: 16 });
      $('#cfg-result').textContent = `✅ 测试通过：${(r.content || '').trim().slice(0, 40)}`;
      updateBadges();
    } catch (e) {
      $('#cfg-result').textContent = `❌ ${String(e.message || e).slice(0, 200)}`;
    }
  };
  $('#cfg-close').onclick = () => $('#cfg-panel').classList.add('hidden');
  $('#btn-kb').onclick = () => {
    const q = prompt('搜索本地知识库（回车查看全部）', '');
    const hits = q ? kbSearch(q, 8) : state.kb.slice(0, 8);
    const box = $('#kb-box');
    box.classList.toggle('hidden', false);
    box.innerHTML = hits.length
      ? hits.map((h) => `<div class="kb-item"><span class="kb-cat">${esc(h.category || '')}</span> ${esc(h.content)}</div>`).join('')
      : '<div class="kb-item">没找到相关条目</div>';
  };
  document.querySelectorAll('.chip[data-q]').forEach((c) => {
    c.onclick = () => { $('#input').value = c.dataset.q; $('#input').focus(); };
  });
  document.addEventListener('click', (e) => {
    if (e.target.id === 'cfg-mask') $('#cfg-panel').classList.add('hidden');
  });

  init();
})();

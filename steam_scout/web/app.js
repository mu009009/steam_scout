/* Steam 市场侦察兵 · 前端逻辑（零依赖） */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const messagesEl = $('#messages');
  const inputEl = $('#input');
  const sendBtn = $('#send');
  let session = localStorage.getItem('scout_session') || ('s' + Math.random().toString(36).slice(2, 10));
  localStorage.setItem('scout_session', session);
  let busy = false;

  // ---------- Markdown 渲染（安全：先转义） ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(t) {
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return t;
  }

  function renderMarkdown(text) {
    const lines = String(text).split('\n');
    let html = '';
    let i = 0;
    let list = null; // {tag, items:[]}

    const flushList = () => {
      if (!list) return;
      html += `<${list.tag}>${list.items.map((x) => `<li>${x}</li>`).join('')}</${list.tag}>`;
      list = null;
    };

    while (i < lines.length) {
      const line = lines[i];
      // 代码块
      if (/^```/.test(line.trim())) {
        flushList();
        const lang = line.trim().slice(3);
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++;
        html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      // 表格
      if (/^\|.*\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        flushList();
        const header = line.trim().split('|').slice(1, -1).map((c) => c.trim());
        const body = [];
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
          body.push(lines[i].trim().split('|').slice(1, -1).map((c) => c.trim()));
          i++;
        }
        html += '<table><thead><tr>' + header.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>';
        for (const r of body) html += '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        html += '</tbody></table>';
        continue;
      }
      // 标题
      const hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) {
        flushList();
        const lv = hm[1].length;
        html += `<h${lv}>${inline(hm[2])}</h${lv}>`;
        i++;
        continue;
      }
      // 分隔线
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushList(); html += '<hr>'; i++; continue; }
      // 引用
      if (/^>\s?/.test(line)) {
        flushList();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>`;
        continue;
      }
      // 列表
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(inline((ul || ol)[1]));
        i++;
        continue;
      }
      // 空行
      if (!line.trim()) { flushList(); i++; continue; }
      // 段落
      flushList();
      html += `<p>${inline(line)}</p>`;
      i++;
    }
    flushList();
    return html;
  }

  // ---------- 全局提示与等待话术 ----------
  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  const WAIT_COPY = [
    '正在比对品类新游发行趋势…',
    '正在拉取头部竞品的价格 / 好评率 / 在线人数…',
    '正在检索行业新闻与 B 站评测热度…',
    '正在检索知识库中 UP 主的方法论要点…',
    '正在计算六维市场潜力评分…',
    '正在评估开发周期与上线窗口…',
    '正在结合数据撰写专家解读…',
    '复杂问题通常需要 30~90 秒，请耐心等待，结果会自动生成…',
  ];

  // ---------- PDF 导出（打印另存为 PDF） ----------
  function extractTitle(md) {
    const m = String(md).match(/^#\s*《([^》\n]+)》/);
    return m ? `${m[1]} 立项评估报告` : 'SteamScout 评估报告';
  }

  function exportPDF(title, markdownText) {
    const w = window.open('', '_blank');
    if (!w) { alert('浏览器拦截了弹窗，请允许本站弹窗后重试'); return; }
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: "Microsoft YaHei","PingFang SC",sans-serif; color:#111; background:#fff; margin:0; padding:40px 48px; font-size:13px; line-height:1.75; }
  h1 { font-size:20px; border-bottom:2px solid #222; padding-bottom:8px; margin-bottom:18px; }
  h2 { font-size:16px; margin:20px 0 8px; }
  h3 { font-size:14px; margin:14px 0 6px; }
  table { border-collapse:collapse; width:100%; margin:10px 0; font-size:12.5px; }
  th,td { border:1px solid #999; padding:6px 8px; text-align:left; }
  th { background:#f0f0f0; }
  blockquote { border-left:3px solid #666; background:#f7f7f7; padding:6px 12px; margin:8px 0; color:#444; }
  code { background:#f2f2f2; padding:1px 5px; border-radius:3px; font-family:Consolas,monospace; }
  pre { background:#f5f5f5; padding:10px; border:1px solid #ddd; overflow-x:auto; }
  hr { border:none; border-top:1px solid #ccc; }
  .footer { margin-top:28px; color:#888; font-size:11px; border-top:1px solid #ccc; padding-top:8px; }
  @media print { body { padding:10mm 12mm; } }
</style></head>
<body>${renderMarkdown(markdownText)}
<div class="footer">由 Steam 市场侦察兵（SteamScout）生成 · 数据来源：Steam 商店公开数据 / 网络检索 / 本地知识库 · 本报告为概率性分析，市场未来不可预测</div>
<script>window.addEventListener('load', function(){ setTimeout(function(){ window.print(); }, 350); });<\/script>
</body></html>`;
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function exportProject(slug) {
    const p = projectCache.find((x) => x.slug === slug);
    if (!p) return;
    if (p.report) {
      exportPDF(`${p.name} 立项评估报告`, p.report);
    } else {
      alert('该项目暂无报告数据（旧版服务端建档）。重启服务端后重新评估一次即可导出。');
    }
  }

  function addExportButton(meta, getContent) {
    const b = document.createElement('button');
    b.className = 'mini-export';
    b.textContent = '⤓ 导出PDF';
    b.title = '将评估报告导出为 PDF';
    b.onclick = () => {
      const content = getContent();
      if (content) exportPDF(extractTitle(content), content);
      else alert('暂无报告内容可导出');
    };
    meta.appendChild(b);
    return b;
  }

  // ---------- 消息构建 ----------
  function addMsg(role) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    const meta = document.createElement('div');
    meta.className = 'meta';
    wrap.appendChild(meta);
    messagesEl.appendChild(wrap);
    scrollDown();
    return { wrap, bubble, meta, tools: [], statusEl: null, reportEl: null, convId: null, scoreShown: false, textBuf: '' };
  }

  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function addStatusLine(wrap, text) {
    const el = document.createElement('div');
    el.className = 'status-line';
    el.innerHTML = `<span class="spinner"></span><span>${esc(text)}</span><span class="elapsed"></span><div class="pb-track slim"><div class="pb-indet"></div></div>`;
    wrap.insertBefore(el, wrap.firstChild); // 顶部常驻，生成期间始终可见
    scrollDown();
    return el;
  }

  function addToolChip(wrap, name, status, summary) {
    const chip = document.createElement('span');
    chip.className = 'tool-chip' + (status === 'error' ? ' error' : '');
    chip.textContent = `🔧 ${name}` + (status === 'error' ? ' ✗' : ' ✓');
    if (summary) chip.title = summary;
    wrap.querySelector('.tools')?.appendChild(chip);
  }

  function ensureToolsRow(wrap) {
    let row = wrap.querySelector('.tools');
    if (!row) { row = document.createElement('div'); row.className = 'tools'; wrap.appendChild(row); }
    return row;
  }

  function addFeedback(meta, convId) {
    const fb = document.createElement('div');
    fb.className = 'fb';
    const mk = (label) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        fb.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'answer', refId: String(convId), rating: label === '👍' ? 1 : -1 }) }).catch(() => {});
      };
      return b;
    };
    fb.appendChild(mk('👍'));
    fb.appendChild(mk('👎'));
    meta.appendChild(fb);
  }

  // ---------- 发送与 SSE 接收 ----------
  async function send(text) {
    if (busy || !text.trim()) return;
    const msg = text.trim();

    // 本地动作：导出报告不需要问 AI（前端直接执行，零 token 成本）
    const mExport = msg.match(/^导出项目[「"]([^」"]+)[」"]的最近一次评估报告/) || msg.match(/^导出.{0,12}最近一次评估报告/);
    if (mExport) {
      const key = mExport[1] || '';
      const p = key
        ? (projectCache.find((x) => x.name === key) || projectCache.find((x) => x.name.includes(key) || key.includes(x.name)))
        : projectCache[0];
      addMsg('user').bubble.textContent = msg;
      const ai = addMsg('assistant');
      if (p?.report) {
        ai.bubble.innerHTML = `<p>📄 正在导出《${esc(p.name)}》的评估报告——在弹出的打印窗口中选择「另存为 PDF」即可。</p>`;
        exportPDF(`${p.name} 立项评估报告`, p.report);
      } else {
        ai.bubble.innerHTML = '<p>⚠️ 没有找到对应的项目档案。可先在左侧「项目档案」确认项目名，或先做一次立项评估。</p>';
      }
      scrollDown();
      return;
    }

    busy = true;
    sendBtn.disabled = true;
    inputEl.placeholder = '⏳ 正在生成回答，可先把下一条打在输入框，完成后发送';

    const userMsg = addMsg('user');
    userMsg.bubble.textContent = text.trim();
    const ai = addMsg('assistant');
    let statusLine = addStatusLine(ai.wrap, '正在启动…');
    const t0 = Date.now();
    let elapsedEl = statusLine.querySelector('.elapsed');
    let toolCount = 0;
    let lastStatusText = '正在调研与生成…';
    const ticker = setInterval(() => {
      if (elapsedEl) elapsedEl.textContent = `${Math.floor((Date.now() - t0) / 1000)}s`;
      // 超过 4 秒没有新的服务端状态时，显示工具调用计数，保持"活着"的感觉
      if (statusLine && statusLine.isConnected && Date.now() - (ai.lastStatusAt || 0) > 4000) {
        const span = statusLine.querySelector('span:nth-child(2)');
        if (span) span.textContent = toolCount ? `正在调研与生成…（已调用 ${toolCount} 次工具）` : lastStatusText;
      }
    }, 1000);
    // 滚动等待话术（真实状态事件优先展示）
    let copyIdx = 0;
    const rotator = setInterval(() => {
      if (!ai.phaseEl || !ai.phaseEl.isConnected) return;
      if (Date.now() - (ai.lastStatusAt || 0) < 4500) return;
      const sub = ai.phaseEl.querySelector('.pb-sub');
      if (sub) sub.textContent = WAIT_COPY[copyIdx++ % WAIT_COPY.length];
    }, 6500);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, message: text.trim() }),
    });

    if (!res.ok || !res.body) {
      statusLine.remove();
      ai.bubble.innerHTML = `<p>请求失败（HTTP ${res.status}）</p>`;
      busy = false; sendBtn.disabled = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let gotContent = false;

    const renderBuf = () => {
      if (!ai.textBuf) return;
      ai.bubble.innerHTML = (ai.scoreEl ? ai.scoreEl.outerHTML : '') + (ai.reportEl ? ai.reportEl.outerHTML : '') + renderMarkdown(ai.textBuf);
      scrollDown();
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          let e;
          try { e = JSON.parse(line.slice(5).trim()); } catch { continue }
          switch (e.type) {
            case 'phase': {
              // 立项评估进度横幅（含进度条 + 百分比 + 滚动话术）；此时隐藏通用状态行
              if (statusLine && statusLine.parentNode) statusLine.remove();
              statusLine = null;
              const pct = Math.max(8, Math.round((e.index / e.total) * 100 - 100 / e.total / 2));
              if (!ai.phaseEl) {
                ai.phaseEl = document.createElement('div');
                ai.phaseEl.className = 'phase-banner';
                ai.wrap.insertBefore(ai.phaseEl, ai.wrap.firstChild);
              }
              ai.phaseEl.className = 'phase-banner';
              ai.phaseEl.innerHTML = `<div class="pb-row">📊 立项评估进行中 · <b>第 ${e.index}/${e.total} 步</b>：${esc(e.text)} <span class="elapsed"></span></div><div class="pb-track"><div class="pb-fill" style="width:${pct}%"></div></div><div class="pb-sub">${esc(WAIT_COPY[0])}</div>`;
              elapsedEl = ai.phaseEl.querySelector('.elapsed');
              scrollDown();
              break;
            }
            case 'reasoning': {
              // 推理模型思考过程（可折叠）
              if (!ai.thinkEl) {
                ai.thinkEl = document.createElement('details');
                ai.thinkEl.className = 'thinking';
                ai.thinkEl.innerHTML = '<summary>💭 模型思考中…</summary><div class="think-body"></div>';
                ai.thinkEl.open = true;
                ai.wrap.insertBefore(ai.thinkEl, ai.bubble);
                ai.thinkBody = ai.thinkEl.querySelector('.think-body');
                ai.thinkLen = 0;
              }
              ai.thinkBody.textContent += e.text;
              ai.thinkLen += e.text.length;
              if (ai.thinkLen > 4000) ai.thinkBody.textContent = '…' + ai.thinkBody.textContent.slice(-4000);
              if (Date.now() - (ai.lastThinkScroll || 0) > 400) { scrollDown(); ai.lastThinkScroll = Date.now(); }
              break;
            }
            case 'status':
              ai.lastStatusAt = Date.now();
              if (statusLine && statusLine.isConnected) {
                statusLine.innerHTML = `<span class="spinner"></span><span>${esc(e.text)}</span><span class="elapsed"></span><div class="pb-track slim"><div class="pb-indet"></div></div>`;
                elapsedEl = statusLine.querySelector('.elapsed');
              } else {
                ai.lastStatusAt = Date.now();
              }
              break;
            case 'tool':
              if (e.status !== 'start') toolCount++;
              ensureToolsRow(ai.wrap);
              if (e.status === 'start') addToolChip(ai.wrap, e.name, 'start');
              else addToolChip(ai.wrap, e.name, e.status, e.summary);
              scrollDown();
              break;
            case 'scores': {
              if (!ai.scoreEl) {
                ai.scoreEl = document.createElement('div');
                ai.scoreEl.className = 'score-badge';
                ai.bubble.prepend(ai.scoreEl);
              }
              const c = e.data.collected;
              const coll = c
                ? `<div class="collected">📥 采集：竞品 ${c.competitors ?? 0} 款 ｜ 新游 ${c.releases ?? 0} 条 ｜ 即将上线 ${c.upcoming != null ? c.upcoming + ' 款' : '未获取'}${c.articles ? ` ｜ 情报 ${c.articles} 条` : ''}${c.videos ? ` ｜ B站 ${c.videos} 条` : ''}${c.kb ? ` ｜ 知识库 ${c.kb} 条` : ''}${c.weak ? ' ｜ ⚠️ 部分缺失' : ''}</div>`
                : '';
              ai.scoreEl.innerHTML = `市场潜力 <b>${e.data.total}/100</b>（${e.data.letter}级）｜上线窗口 <b>${e.data.window}</b>｜基准工期 <b>${e.data.devExpected}</b> 月（${e.data.devRange[0]}~${e.data.devRange[1]}）｜数据完整度 ${e.data.completeness}%${coll}`;
              ai.scoreShown = true;
              scrollDown();
              break;
            }
            case 'report': {
              if (!ai.reportEl) {
                ai.reportEl = document.createElement('div');
                ai.reportEl.style.cssText = 'border-top:1px dashed var(--border);padding-top:10px;margin-bottom:14px;';
                ai.bubble.appendChild(ai.reportEl);
              }
              ai.reportEl.innerHTML = renderMarkdown(e.text);
              ai.reportRaw = e.text;
              if (ai.phaseEl) {
                const fill = ai.phaseEl.querySelector('.pb-fill');
                const sub = ai.phaseEl.querySelector('.pb-sub');
                if (fill) fill.style.width = '88%';
                if (sub) sub.textContent = '核心报告已生成，正在撰写专家解读…';
              }
              scrollDown();
              break;
            }
            case 'delta':
              if (ai.thinkEl) {
                ai.thinkEl.open = false;
                ai.thinkEl.querySelector('summary').textContent = '💭 思考过程（已完成，点击查看）';
              }
              ai.textBuf += e.text;
              gotContent = true;
              renderBuf();
              break;
            case 'done':
              clearInterval(ticker);
              clearInterval(rotator);
              if (ai.phaseEl) {
                ai.phaseEl.className = 'phase-banner done';
                ai.phaseEl.innerHTML = `✅ 评估完成（用时 ${Math.floor((Date.now() - t0) / 1000)}s）<div class="pb-track"><div class="pb-fill" style="width:100%"></div></div>`;
              }
              if (ai.reportRaw) {
                addExportButton(ai.meta, () => `${ai.reportRaw}\n\n${ai.textBuf}`);
              }
              renderSuggestions(ai.wrap, e.suggestions, () => (ai.reportRaw ? `${ai.reportRaw}\n\n${ai.textBuf}` : ai.textBuf));
              ai.convId = e.convId;
              addFeedback(ai.meta, e.convId);
              break;
            case 'error':
              clearInterval(ticker);
              if (ai.phaseEl) { ai.phaseEl.remove(); }
              if (!gotContent) { ai.bubble.innerHTML = `<p>❌ ${esc(e.message)}</p>`; }
              break;
          }
        }
      }
    } catch (err) {
      if (!gotContent) ai.bubble.innerHTML = `<p>连接中断：${esc(String(err))}</p>`;
    } finally {
      clearInterval(ticker);
      clearInterval(rotator);
      if (statusLine && statusLine.parentNode) statusLine.remove();
      if (!ai.textBuf && !ai.reportEl) ai.bubble.innerHTML = '<p>（无内容）</p>';
      busy = false;
      sendBtn.disabled = false;
      inputEl.placeholder = '';
      loadStats();
    }
  }

  // ---------- 侧栏：会话与项目 ----------
  let sessionsCache = [];
  let projectCache = [];

  function renderSessionList(sessions) {
    sessionsCache = sessions;
    const list = $('#sessions-list');
    if (!sessions.length) { list.innerHTML = '<div class="muted">暂无对话，点上面「新建对话」开始</div>'; return; }
    list.innerHTML = sessions.map((s) => {
      const title = (s.title || '新对话').slice(0, 22);
      const cls = s.session === session ? 'session-item active' : 'session-item';
      return `<div class="${cls}" data-sid="${esc(s.session)}"><div class="s-title"><button class="mini-del" data-del="${esc(s.session)}" title="删除对话">✕</button>💬 ${esc(title)}</div><div class="s-meta">${esc((s.last_at || '').slice(5, 16))} · ${s.n} 条消息</div></div>`;
    }).join('');
    list.querySelectorAll('.session-item').forEach((el) => {
      el.onclick = () => switchSession(el.dataset.sid);
    });
    list.querySelectorAll('button[data-del]').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); deleteSessionConfirm(b.dataset.del); };
    });
  }

  async function refreshSessions() {
    try {
      const j = await (await fetch('/api/sessions')).json();
      renderSessionList(j.sessions ?? []);
      return j.sessions ?? [];
    } catch { return sessionsCache; }
  }

  /** 删除会话（当前会话被删则自动切到最近一个或新建） */
  async function deleteSessionConfirm(id) {
    if (busy) { toast('⏳ 正在生成回答中，完成后可删除'); return; }
    const s = sessionsCache.find((x) => x.session === id);
    if (!confirm(`确定删除对话「${(s?.title || '新对话').slice(0, 20)}」？\n对话记录将永久删除，不可恢复。`)) return;
    await fetch('/api/delete-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: id }),
    }).catch(() => {});
    toast('对话已删除');
    const left = await refreshSessions();
    loadStats();
    if (session === id) {
      if (left.length) await switchSession(left[0].session);
      else newChat();
    }
  }

  function refreshProjects(projects) {
    projectCache = projects;
    const list = $('#projects-list');
    if (!projects.length) { list.innerHTML = '<div class="muted">暂无（评估立项后自动建档）</div>'; return; }
    list.innerHTML = projects.map((p) =>
      `<div class="session-item" data-slug="${esc(p.slug)}"><div class="s-title"><button class="mini-del" data-delslug="${esc(p.slug)}" title="删除项目档案">✕</button><button class="mini-export" data-exp="${esc(p.slug)}" title="导出评估报告为 PDF">⤓ PDF</button><button class="mini-export" data-recall="${esc(p.slug)}" title="输出该项目的评估结论">📌 结论</button>🎮 ${esc(p.name)}</div><div class="s-meta">${esc(p.genre || '?')} · ${esc((p.created_at || '').slice(5, 16))}</div></div>`
    ).join('');
    list.querySelectorAll('div[data-slug]').forEach((el) => {
      el.onclick = () => openProject(el.dataset.slug);
    });
    list.querySelectorAll('button[data-exp]').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); exportProject(b.dataset.exp); };
    });
    list.querySelectorAll('button[data-recall]').forEach((b) => {
      b.onclick = (ev) => {
        ev.stopPropagation();
        if (busy) { toast('⏳ 正在生成回答中，完成后可回顾'); return; }
        const p = projectCache.find((x) => x.slug === b.dataset.recall);
        send(`输出项目「${p?.name ?? b.dataset.recall}」的评估结论`);
      };
    });
    list.querySelectorAll('button[data-delslug]').forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); deleteProjectConfirm(b.dataset.delslug); };
    });
  }

  /** 删除项目档案（评估记录一并删除，对话不受影响） */
  async function deleteProjectConfirm(slug) {
    if (busy) { toast('⏳ 正在生成回答中，完成后可删除'); return; }
    const p = projectCache.find((x) => x.slug === slug);
    if (!confirm(`确定删除项目档案「${p?.name ?? slug}」？\n其评估记录将一并删除（对话不受影响），不可恢复。`)) return;
    await fetch('/api/delete-project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    }).catch(() => {});
    toast('项目档案已删除');
    refreshProjectsRemote();
    loadStats();
  }

  function refreshProjectsRemote() {
    fetch('/api/projects').then((r) => r.json()).then((j) => refreshProjects(j.projects ?? [])).catch(() => {});
  }

  /** 打开项目：跳转到对应会话查看对话；老数据无会话关联时直接展示报告 */
  function openProject(slug) {
    const p = projectCache.find((x) => x.slug === slug);
    if (!p) return;
    if (busy) { toast('⏳ 正在生成回答中，完成后即可查看项目档案'); return; }
    if (p.session) {
      switchSession(p.session);
    } else if (p.report) {
      messagesEl.innerHTML = '';
      const msg = addMsg('assistant');
      msg.bubble.innerHTML = `<div class="score-badge">🎮 项目档案：${esc(p.name)}（${esc(p.genre || '?')}）· 历史评估报告</div>` + renderMarkdown(p.report);
      addExportButton(msg.meta, () => p.report);
      scrollDown();
    } else {
      // 旧版服务端：接口未返回报告/会话字段
      const msg = addMsg('assistant');
      msg.bubble.innerHTML = '<p>⚠️ 该项目由旧版服务端建档，缺少报告数据。请关闭服务器窗口重新双击 start.bat（升级到最新版），刷新页面后即可正常查看。</p>';
      scrollDown();
    }
  }

  // ---------- 会话切换 ----------
  function renderMessages(messages) {
    messagesEl.innerHTML = '';
    for (const m of messages) {
      const msg = addMsg(m.role);
      if (m.role === 'assistant') msg.bubble.innerHTML = renderMarkdown(m.content);
      else msg.bubble.textContent = m.content;
      if (m.role === 'assistant' && m.id) addFeedback(msg.meta, m.id);
      if (m.role === 'assistant' && String(m.content).includes('立项评估报告')) {
        addExportButton(msg.meta, () => m.content);
      }
      if (m.role === 'assistant' && m.meta?.suggestions?.length) {
        renderSuggestions(msg.wrap, m.meta.suggestions, () => m.content);
      }
    }
    scrollDown();
  }

  /** 把模板填入输入框，并自动选中 XXX 占位符，方便直接打字替换 */
  function fillInput(text, placeholder) {
    inputEl.value = text;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    inputEl.focus();
    let start = -1;
    let len = 0;
    if (placeholder && text.includes(placeholder)) {
      start = text.indexOf(placeholder);
      len = placeholder.length;
    } else {
      const m = text.match(/X{3,}/);
      if (m) { start = text.indexOf(m[0]); len = m[0].length; }
    }
    if (start >= 0) {
      try { inputEl.setSelectionRange(start, start + len); } catch {}
    }
  }

  /** 下一步操作建议（随消息持久化：重开页面/切换对话后依然存在） */
  function renderSuggestions(wrap, suggestions, getContent) {
    if (!suggestions || !suggestions.length) return;
    if (wrap.querySelector('.sugg-row')) return;
    const row = document.createElement('div');
    row.className = 'sugg-row';
    for (const s of suggestions) {
      const b = document.createElement('button');
      b.className = 'sugg';
      b.textContent = s.label;
      b.onclick = () => {
        if (s.type === 'export') {
          const content = getContent();
          if (content) exportPDF(extractTitle(content), content);
          else alert('暂无报告内容可导出');
          return;
        }
        if (s.prefill) { fillInput(s.text || s.label, s.select); return; }
        if (busy) { toast('⏳ 正在生成回答中，完成后可继续'); return; }
        send(s.text || s.label);
      };
      row.appendChild(b);
    }
    wrap.appendChild(row);
    scrollDown();
  }

  /** 新对话欢迎语（含按步骤的快捷按钮） */
  function renderWelcome() {
    const w = addMsg('assistant');
    w.bubble.innerHTML = '<p>👋 新对话已就绪。按下面三步来最顺：</p><ol><li><b>① 评估项目</b>：描述你的游戏想法（含「立项/值不值得做/多久上线」）→ 自动调研并出评分报告</li><li><b>② 看结论/深挖</b>：输出项目结论（读档案，不重跑）或深挖品类竞品</li><li><b>③ 导出</b>：把评估报告导出成 PDF 分享</li></ol><p class="tiny">不同项目建议开不同对话；评估结果会自动进入「项目档案」，随时可回看、输出结论或导出 PDF。</p>';
    renderSuggestions(w.wrap, [
      { prefill: true, label: '① 📊 评估我的项目', text: '评估立项：《XXX》2D 肉鸽卡牌，2人团队，计划12个月上线——值不值得做？', select: 'XXX' },
      { prefill: true, label: '② 📌 输出项目评估结论', text: '输出项目「XXXXXX」的评估结论', select: 'XXXXXX' },
      { prefill: true, label: '③ ⤓ 导出报告 PDF', text: '导出项目「XXXXXX」的最近一次评估报告', select: 'XXXXXX' },
    ], () => '');
  }

  async function switchSession(id) {
    if (busy) { toast('⏳ 正在生成回答中，完成后即可切换对话'); return; } // 生成中禁止切换
    session = id;
    localStorage.setItem('scout_session', id);
    renderSessionList(sessionsCache); // 先高亮
    try {
      const j = await (await fetch('/api/history?session=' + encodeURIComponent(id))).json();
      renderMessages(j.messages ?? []);
    } catch {}
    inputEl.focus();
  }

  function newChat() {
    if (busy) { toast('⏳ 正在生成回答中，完成后即可新建对话'); return; }
    session = 's' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('scout_session', session);
    messagesEl.innerHTML = '';
    renderWelcome();
    renderSessionList(sessionsCache);
    refreshSessions();
    inputEl.focus();
  }

  async function initSessions() {
    let sessions = [];
    try { sessions = (await (await fetch('/api/sessions')).json()).sessions ?? []; } catch {}
    renderSessionList(sessions);
    const saved = localStorage.getItem('scout_session');
    if (saved && sessions.some((s) => s.session === saved)) await switchSession(saved);
    else if (sessions.length) await switchSession(sessions[0].session);
    else newChat();
  }

  // ---------- 侧栏 ----------
  async function loadStats() {
    try {
      const r = await fetch('/api/stats');
      const j = await r.json();
      const dot = $('#llm-dot');
      dot.className = 'dot' + (j.llm ? ' on' : '');
      $('#llm-status').textContent = j.llm ? 'LLM 已配置 · 全功能可用' : 'LLM 未配置（离线评估可用）';
      $('#st-insights').textContent = j.counts.insights;
      $('#st-sources').textContent = j.counts.sources;
      $('#st-projects').textContent = j.counts.projects;
      $('#st-evals').textContent = j.counts.evaluations;
      $('#st-digest').textContent = j.counts.lastDigest ? `上次复盘：${j.counts.lastDigest.replace('T', ' ').slice(0, 16)}` : '上次复盘：从未';
      const cfgRow = $('#llm-config-row');
      if (cfgRow) cfgRow.classList.toggle('hidden', Boolean(j.llm));
      // 未配置 LLM 时，首次自动弹出配置向导
      if (!j.llm && !cfgPrompted && !localStorage.getItem('scout_cfg_dismissed')) {
        cfgPrompted = true;
        setTimeout(() => { if (!document.hidden) openLlmConfig(); }, 600);
      }
      refreshSessions();
      refreshProjectsRemote();
    } catch {}
  }

  // ---------- 数据盘点 ----------
  function renderInventory(inv) {
    const st = { fresh: '🟢 7天内有数据', stale: '🟡 超过7天，建议重新拉取', none: '⚪ 无数据，评估时自动拉取' };
    const genres = (inv.genres ?? []).slice(0, 20).map((g) => `
      <tr><td>${esc(g.name)}</td><td>${g.insights}</td><td>${g.projects}</td><td>${g.lastAt ? esc(String(g.lastAt).slice(5, 16)) : '—'}</td><td>${st[g.status] ?? esc(g.status)}</td>
      <td><button class="mini-export" data-fill="更新数据：分析「${esc(g.name)}」品类当前的市场趋势、竞争格局与进入机会">更新数据</button></td></tr>`).join('');
    const projects = (inv.projects ?? []).map((p) => `
      <tr><td>${esc(p.name)}</td><td>${esc(p.genre || '—')}</td><td>${esc(String(p.updated_at || '').slice(0, 16))}</td><td>${p.hasReport ? '✅ 有报告' : '—'}</td>
      <td><button class="mini-export" data-fill="输出项目「${esc(p.name)}」的评估结论">输出结论</button></td></tr>`).join('');
    return `
      <p><b>概览</b>：知识洞察 <b>${inv.kb.insights}</b> 条 ｜ 原始来源 <b>${inv.kb.sources}</b> 条 ｜ 项目档案 <b>${inv.projects.length}</b> 个 ｜ 待调研 <b>${inv.queuePending}</b> 条 ｜ 上次复盘 ${inv.kb.lastDigest ? esc(String(inv.kb.lastDigest).replace('T', ' ').slice(0, 16)) : '从未'}</p>
      <p class="tiny">运行期搜索缓存 ${inv.cache.size} 条（${inv.cache.ttlMinutes} 分钟有效，重启清空）；超过 ${inv.rules.staleDays} 天的品类数据建议重新拉取。</p>
      <h3>品类覆盖</h3>
      <table><tr><td>品类</td><td>洞察</td><td>项目</td><td>最近更新</td><td>状态</td><td></td></tr>${genres || '<tr><td colspan="6">暂无品类数据</td></tr>'}</table>
      ${inv.otherTagCount ? `<p class="tiny">另有 ${inv.otherTagCount} 个非品类主题标签（方法论/发行/运营等）未列入上表。</p>` : ''}
      <h3>项目档案</h3>
      <table><tr><td>项目</td><td>品类</td><td>更新时间</td><td>报告</td><td></td></tr>${projects || '<tr><td colspan="5">暂无项目</td></tr>'}</table>
      <h3>怎么判断要不要拉数据</h3>
      <ul>
        <li><b>⚪ 无数据</b>：该品类从未调研过 → 直接发起评估，会自动拉取（30~90 秒）</li>
        <li><b>🟡 超过 7 天</b>：可能过期 → 建议重新评估一次，拉最新新游/竞品/在线数据</li>
        <li><b>🟢 7 天内</b>：可直接评估，会命中知识库与缓存，更快</li>
        <li><b>项目已有报告</b>：不需要再拉数据 → 用「输出结论」读档案（零成本）</li>
      </ul>`;
  }

  async function openInventory() {
    const mask = $('#inv-mask');
    const body = $('#inv-body');
    if (!mask || !body) return;
    mask.classList.remove('hidden');
    body.innerHTML = '加载中…';
    try {
      const inv = await (await fetch('/api/data-inventory')).json();
      body.innerHTML = renderInventory(inv);
      body.querySelectorAll('button[data-fill]').forEach((b) => {
        b.onclick = () => { closeInventory(); fillInput(b.dataset.fill); };
      });
    } catch (e) {
      body.innerHTML = `<p>读取失败：${esc(String(e.message || e))}</p>`;
    }
  }
  function closeInventory() { $('#inv-mask')?.classList.add('hidden'); }

  // ---------- LLM 配置 ----------
  let cfgPrompted = false;
  async function openLlmConfig() {
    const mask = $('#cfg-mask');
    if (!mask) return;
    mask.classList.remove('hidden');
    const res = $('#cfg-result');
    if (res) { res.textContent = ''; res.style.color = 'var(--muted)'; }
    try {
      const c = await (await fetch('/api/llm-config')).json();
      $('#cfg-base').value = c.baseUrl || '';
      $('#cfg-model').value = c.model || '';
      $('#cfg-key').value = '';
      $('#cfg-key').placeholder = c.apiKeyMasked ? `已保存：${c.apiKeyMasked}（留空保持不变）` : 'sk-…';
    } catch {}
    loadDataProvider();
  }
  // ---------- 可选第三方/付费数据源 ----------
  let dpPresets = [];
  function renderDpHowto(id) {
    const el = $('#dp-howto');
    if (!el) return;
    const p = dpPresets.find((x) => x.id === id);
    if (!p) { el.innerHTML = ''; return; }
    el.innerHTML = `${p.howto}${p.signup ? ` <a href="${p.signup}" target="_blank" rel="noopener">打开官网 ↗</a>` : ''}`;
  }
  async function loadDataProvider() {
    const sel = $('#dp-provider');
    if (!sel) return;
    try {
      const d = await (await fetch('/api/data-provider')).json();
      dpPresets = d.presets || [];
      // 下拉项由后端预设渲染：再也不会出现「前端写了、后端没有」的假数据源
      // hidden = 实测不可用的源（如 SteamSpy 被 Cloudflare 全拦），仅在已选中时保留显示
      const shown = dpPresets.filter((p) => !p.hidden || p.id === (d.provider || ''));
      sel.innerHTML = '<option value="">不启用（默认：仅官方接口）</option>' +
        shown.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
      sel.value = d.provider || '';
      renderDpHowto(d.provider || '');
      if ($('#dp-key')) {
        $('#dp-key').value = '';
        $('#dp-key').placeholder = d.hasKey ? `已保存：${d.apiKeyMasked}（留空保持不变）` : '付费源需要填写；免费源可留空';
      }
      const isCustom = (d.provider || '') === 'custom';
      if ($('#dp-url')) $('#dp-url').value = isCustom ? (d.urlTemplate || '') : '';
      if ($('#dp-map')) $('#dp-map').value = isCustom && d.fieldMap && Object.keys(d.fieldMap || {}).length ? JSON.stringify(d.fieldMap) : '';
      const res = $('#dp-result');
      if (res) {
        res.style.color = 'var(--muted)';
        const paused = d.blockedUntil ? `（该源最近连续失败，已暂停到 ${new Date(d.blockedUntil).toLocaleTimeString('zh-CN')}）` : '';
        res.textContent = d.configured ? `当前：${d.label}${d.hasKey ? '（已存 Key）' : ''} —— 评估时会用该源补齐缺失字段${paused}` : '当前未启用数据源：仅使用 Steam 官方接口（免费模式，推荐）';
      }
    } catch {}
  }
  async function saveDataProvider() {
    const res = $('#dp-result');
    const btn = $('#dp-save');
    if (!res || !btn) return;
    res.style.color = 'var(--muted)';
    res.textContent = '正在测试数据源…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/data-provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: $('#dp-provider').value,
          apiKey: $('#dp-key').value.trim(),
          urlTemplate: $('#dp-url').value.trim(),
          fieldMap: $('#dp-map').value.trim(),
          test: true,
        }),
      });
      const j = await r.json();
      if (j.ok) {
        res.style.color = 'var(--accent2)';
        res.textContent = j.provider
          ? `✅ 已保存并测试通过：${j.label}${j.test?.sample?.owners ? `（样本拥有者 ${j.test.sample.owners}）` : ''}，已写入 .env`
          : '✅ 已关闭第三方数据源，评估仅使用 Steam 官方接口';
        toast(j.provider ? `✅ 数据源：${j.label}` : '✅ 已关闭第三方数据源');
      } else {
        res.style.color = 'var(--danger)';
        res.textContent = `❌ ${j.error || '保存失败'}`;
      }
    } catch (e) {
      res.style.color = 'var(--danger)';
      res.textContent = `❌ 请求失败：${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }
  function closeLlmConfig() {
    $('#cfg-mask')?.classList.add('hidden');
    localStorage.setItem('scout_cfg_dismissed', '1');
  }
  async function saveLlmConfig() {
    const res = $('#cfg-result');
    const btn = $('#cfg-save');
    res.textContent = '正在测试连接…';
    res.style.color = 'var(--muted)';
    btn.disabled = true;
    try {
      const r = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: $('#cfg-key').value.trim(),
          baseUrl: $('#cfg-base').value.trim(),
          model: $('#cfg-model').value.trim(),
          test: true,
        }),
      });
      const j = await r.json();
      if (j.ok) {
        res.style.color = 'var(--accent2)';
        res.textContent = `✅ 配置已保存并通过测试${j.test?.reply ? `（模型回复：${j.test.reply}）` : ''}，已写入 .env`;
        toast('✅ LLM 配置已生效');
        closeLlmConfig();
        loadStats();
      } else {
        res.style.color = 'var(--danger)';
        res.textContent = `❌ ${j.error || '保存失败'}`;
      }
    } catch (e) {
      res.style.color = 'var(--danger)';
      res.textContent = `❌ 请求失败：${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 使用指南弹窗 ----------
  function openGuide() {
    const mask = $('#guide-mask');
    if (mask) mask.classList.remove('hidden');
  }
  function closeGuide() {
    const mask = $('#guide-mask');
    if (mask) mask.classList.add('hidden');
    localStorage.setItem('scout_guide_seen', '1');
  }

  // ---------- 事件 ----------
  function doSend() {
    if (busy) { toast('⏳ 上一轮回答还在生成中，请稍候再发送（输入框内容已保留）'); return; }
    const t = inputEl.value;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    send(t);
  }
  sendBtn.onclick = doSend;
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  });
  document.querySelectorAll('.chip[data-q]').forEach((c) => {
    c.onclick = () => fillInput(c.dataset.q, c.dataset.select);
  });
  $('#btn-digest').onclick = async () => {
    await fetch('/api/digest-now', { method: 'POST' }).catch(() => {});
    const msg = addMsg('assistant');
    msg.bubble.innerHTML = '<p>🔄 市场复盘任务已在后台启动（拉取 Steam 热销/新品/即将推出快照、同步 UP 主新视频、检索行业新闻）。完成后会写入知识库，可在侧栏或问「最近的复盘结论是什么」查看。</p>';
  };
  $('#btn-new').onclick = newChat;
  $('#btn-guide').onclick = openGuide;
  $('#btn-inventory').onclick = openInventory;
  $('#btn-llm-config').onclick = () => { localStorage.removeItem('scout_cfg_dismissed'); openLlmConfig(); };
  $('#guide-close').onclick = closeGuide;
  $('#inv-close').onclick = closeInventory;
  $('#cfg-close').onclick = closeLlmConfig;
  $('#cfg-cancel').onclick = closeLlmConfig;
  $('#cfg-save').onclick = saveLlmConfig;
  if ($('#dp-save')) $('#dp-save').onclick = saveDataProvider;
  if ($('#dp-provider')) $('#dp-provider').onchange = () => {
    const v = $('#dp-provider').value;
    const res = $('#dp-result');
    if (v !== 'custom') { if ($('#dp-url')) $('#dp-url').value = ''; if ($('#dp-map')) $('#dp-map').value = ''; }
    renderDpHowto(v);
    const p = dpPresets.find((x) => x.id === v);
    if (res) {
      res.style.color = 'var(--muted)';
      res.textContent = !v ? '保存后即关闭第三方数据源'
        : p?.needsKey && !p?.free ? '该源需要 API Key，填好后点「保存并测试数据源」'
          : '该源免费、无需 Key；选好后点「保存并测试数据源」';
    }
  };
  $('#guide-mask').onclick = (e) => { if (e.target.id === 'guide-mask') closeGuide(); };
  $('#inv-mask').onclick = (e) => { if (e.target.id === 'inv-mask') closeInventory(); };
  $('#cfg-mask').onclick = (e) => { if (e.target.id === 'cfg-mask') closeLlmConfig(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeGuide(); closeInventory(); closeLlmConfig(); } });

  loadStats();
  initSessions();
  inputEl.focus();
  // 首次使用自动弹出使用指南
  if (!localStorage.getItem('scout_guide_seen')) {
    setTimeout(() => { if (!document.hidden) openGuide(); }, 900);
  }
})();

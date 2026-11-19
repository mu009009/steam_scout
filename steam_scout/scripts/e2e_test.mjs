// 服务器端到端测试：health/stats/静态页/无 LLM 离线评估 SSE 流
const BASE = 'http://127.0.0.1:8791';

const h = await (await fetch(BASE + '/api/health')).json();
console.log('health:', JSON.stringify(h));

const s = await (await fetch(BASE + '/api/stats')).json();
console.log('stats:', JSON.stringify(s.counts), 'llm:', s.llm);

const idx = await (await fetch(BASE + '/'));
console.log('index:', idx.status, (await idx.text()).length, 'bytes');

const proj = await (await fetch(BASE + '/api/projects')).json();
console.log('projects:', JSON.stringify(proj).slice(0, 200));

// 离线立项评估全流程（SSE）
console.log('\n=== 发起离线立项评估（SSE 流）===');
const res = await fetch(BASE + '/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session: 'e2e-test', message: '评估立项：《像素钓鱼模拟器》2D 休闲钓鱼，单人开发，有2年Unity经验，计划8个月上线——值不值得做？' }),
});
console.log('chat status:', res.status, 'content-type:', res.headers.get('content-type'));
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let events = { status: 0, tool: 0, scores: 0, report: 0, delta: 0, done: 0, error: 0 };
let lastTool = null;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith('data:')) continue;
    let e;
    try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
    events[e.type] = (events[e.type] || 0) + 1;
    if (e.type === 'status') console.log('  [status]', e.text);
    else if (e.type === 'tool') console.log('  [tool]', e.name, e.status, (e.summary || '').slice(0, 80));
    else if (e.type === 'scores') console.log('  [scores]', JSON.stringify(e.data));
    else if (e.type === 'report') console.log('  [report] 长度', e.text.length, '| 开头:', e.text.slice(0, 60).replace(/\n/g, ' '));
    else if (e.type === 'delta') console.log('  [delta]', e.text.slice(0, 50));
    else if (e.type === 'error') console.log('  [ERROR]', e.message);
    else if (e.type === 'done') console.log('  [done] convId=', e.convId);
  }
}
console.log('事件统计:', JSON.stringify(events));

const hist = await (await fetch(BASE + '/api/history?session=e2e-test')).json();
console.log('history 条数:', hist.messages.length);

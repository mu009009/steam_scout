// 命令行入口：node cli.mjs "问题" 一次性问答；无参数进入交互 REPL
import readline from 'node:readline';
import { runChat } from './src/agent.mjs';
import { llmConfigured } from './src/llm.mjs';
import { counts } from './src/db.mjs';

const SESSION = 'cli';

function makeEmit() {
  let lastTool = null;
  return (e) => {
    if (e.type === 'status') process.stdout.write(`\n[状态] ${e.text}\n`);
    else if (e.type === 'tool' && e.status === 'start') {
      lastTool = e.name;
      process.stdout.write(`[工具] ${e.name} …`);
    } else if (e.type === 'tool' && e.status === 'end' && lastTool) {
      process.stdout.write(` 完成\n`);
    } else if (e.type === 'tool' && e.status === 'error' && lastTool) {
      process.stdout.write(` 失败: ${e.summary}\n`);
    } else if (e.type === 'delta') process.stdout.write(e.text);
    else if (e.type === 'report') process.stdout.write('\n\n' + e.text + '\n');
    else if (e.type === 'scores') process.stdout.write(`\n[评分] 市场潜力 ${e.data.total}/100（${e.data.letter}）｜窗口 ${e.data.window}｜工期 ${e.data.devExpected} 月\n`);
    else if (e.type === 'error') process.stdout.write(`\n[错误] ${e.message}\n`);
  };
}

async function ask(question) {
  const emit = makeEmit();
  await runChat({ session: SESSION, message: question, emit });
  process.stdout.write('\n\n');
}

if (process.argv[2]) {
  ask(process.argv.slice(2).join(' ')).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  const c = counts();
  console.log(`Steam 市场侦察兵 · 命令行模式（LLM ${llmConfigured() ? '已配置' : '未配置'}）`);
  console.log(`知识库：${c.insights} 条洞察 ｜ ${c.sources} 条来源 ｜ 输入问题回车发送，Ctrl+C 退出`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '你> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const q = line.trim();
    if (!q) { rl.prompt(); return; }
    if (q === 'exit' || q === 'quit') { rl.close(); return; }
    try { await ask(q); } catch (e) { console.error('[错误]', e.message); }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

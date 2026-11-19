import { search } from '../src/retriever.mjs';
import { listInsights, listProjects, getMeta } from '../src/db.mjs';

console.log('=== 1. 知识库检索（播种内容可检索性）===');
for (const q of ['钓鱼游戏 案例', '愿望单 怎么攒', '立项 值不值得', '新品节 Demo', '独立游戏 宣发']) {
  const r = search(q, { limit: 2 });
  console.log(`\nQ: ${q}`);
  for (const it of r) console.log(`  [${it.score}] (${it.category}) ${it.content.slice(0, 70)}`);
}

console.log('\n=== 2. 复盘报告 ===');
const digests = listInsights({ category: '复盘报告', limit: 3 });
console.log('复盘条目:', digests.length);
for (const d of digests) console.log(' ', d.content.slice(0, 150).replace(/\n/g, ' | '));

console.log('\n=== 3. 项目档案 ===');
console.log(listProjects());

console.log('\n=== 4. meta ===');
console.log('last_digest:', getMeta('last_digest'), '| seed_at:', getMeta('seed_at'));

// 网络搜索工具：Bing（免 key）+ 网页正文抓取
import { fetchText, decodeEntities, htmlToText, truncate } from '../util.mjs';

export async function bingSearch(query, limit = 8, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const { text } = await fetchText(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&mkt=zh-CN&count=${Math.min(limit, 20)}`,
      { headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }, timeoutMs: 30000 }
    );
    if (text.includes('b_algo')) {
      const results = [];
      const blocks = text.split('<li class="b_algo"').slice(1);
      for (const b of blocks.slice(0, limit)) {
        const titleM = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleM) continue;
        const snipM = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        results.push({
          title: decodeEntities(htmlToText(titleM[2], 200)),
          url: decodeEntities(titleM[1]),
          snippet: snipM ? decodeEntities(htmlToText(snipM[1], 500)) : '',
        });
      }
      return { query, count: results.length, results };
    }
    if (/没有找到|未找到|no results/i.test(text)) return { query, count: 0, results: [], note: 'Bing 无结果' };
    if (i < tries - 1) { await new Promise((r) => setTimeout(r, 3000)); continue; } // 人机验证页：重试一次
    throw new Error('Bing 返回异常（可能要求人机验证），请稍后重试');
  }
  throw new Error('Bing 返回异常（可能要求人机验证），请稍后重试');
}

export async function fetchPageText(url, maxLen = 6000) {
  const { text } = await fetchText(url, { timeoutMs: 30000 });
  const t = htmlToText(text, maxLen);
  return { url, length: t.length, text: t };
}

export const webTools = [
  {
    name: 'web_search',
    description: '在互联网搜索（Bing，中文优先）。用于查询行业新闻、市场趋势、竞品报道、开发周期案例等 Steam 数据源之外的信息。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词（中文/英文均可）' }, limit: { type: 'integer', description: '最多返回条数，默认8' } }, required: ['query'] },
    handler: async (a) => bingSearch(a.query, a.limit ?? 8),
  },
  {
    name: 'web_fetch_page',
    description: '抓取指定网页正文（自动转纯文本并截断）。用于阅读搜索结果中的文章。',
    parameters: { type: 'object', properties: { url: { type: 'string' }, max_len: { type: 'integer', description: '最大字符数，默认6000' } }, required: ['url'] },
    handler: async (a) => fetchPageText(a.url, a.max_len ?? 6000),
  },
];

export { truncate };

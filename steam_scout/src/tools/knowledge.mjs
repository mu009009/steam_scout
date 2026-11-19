// 知识库工具：检索 / 写入 / 统计 / 数据资产盘点
import { search, kbStats, invalidate } from '../retriever.mjs';
import { addInsight, listInsights, counts } from '../db.mjs';
import { dataInventory, inventorySummary } from '../inventory.mjs';

export const knowledgeTools = [
  {
    name: 'kb_search',
    description: '检索本地知识库（含 B 站 UP 主「Gaby学姐说」的方法论观点、历史调研结论、市场复盘报告、项目评估记录）。优先用中文关键词。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或问题' },
        limit: { type: 'integer', description: '默认8' },
        category: { type: 'string', description: '可选分类：UP主观点/市场数据/调研结论/复盘报告/项目评估/通用' },
      },
      required: ['query'],
    },
    handler: async (a) => ({ query: a.query, results: search(a.query, { limit: a.limit ?? 8, category: a.category }) }),
  },
  {
    name: 'kb_stats',
    description: '查看本地知识库统计（条目数、分类分布）。',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ db: counts(), index: kbStats() }),
  },
  {
    name: 'kb_add_insight',
    description: '把一条有依据的市场数据点/结论写入知识库长期记忆（仅供沉淀本次调研确认的事实，不要臆造）。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '结论内容（含关键数字与日期）' },
        category: { type: 'string', description: '分类：市场数据/调研结论/通用' },
        tags: { type: 'string', description: '逗号分隔的中文标签' },
      },
      required: ['content'],
    },
    handler: async (a) => {
      const id = addInsight({ content: a.content, category: a.category ?? '调研结论', tags: a.tags ?? '', sourceType: 'agent' });
      invalidate();
      return { ok: true, id };
    },
  },
  {
    name: 'kb_list',
    description: '按分类列出知识库条目（用于查看已有结论）。',
    parameters: { type: 'object', properties: { category: { type: 'string' }, limit: { type: 'integer' } }, required: [] },
    handler: async (a) => ({ items: listInsights({ category: a.category, limit: a.limit ?? 20 }) }),
  },
  {
    name: 'data_inventory',
    description: '数据资产盘点：列出本地已有哪些数据（知识洞察/来源/项目档案/品类覆盖/最近更新时间/运行期缓存），并标出哪些品类数据已过期需要重新拉取。用户问"我有哪些数据/哪些还需要拉取"时使用。',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const inv = dataInventory();
      return { summary: inventorySummary(inv), genres: inv.genres, projects: inv.projects, kb: inv.kb, cache: inv.cache, queuePending: inv.queuePending, rules: inv.rules };
    },
  },
];

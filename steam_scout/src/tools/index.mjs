// 工具注册表：汇总所有工具供 LLM 调用
import { steamTools } from './steam.mjs';
import { biliTools } from './bilibili.mjs';
import { webTools } from './websearch.mjs';
import { knowledgeTools } from './knowledge.mjs';
import { runEvaluation } from '../evaluator.mjs';
import { upsertProject, addEvaluation, addInsight, listProjects, listEvaluations } from '../db.mjs';
import { invalidate } from '../retriever.mjs';
import { truncate } from '../util.mjs';

const evaluateTool = {
  name: 'evaluate_project',
  description: '立项评估引擎：输入项目信息与已收集的市场数据，输出市场潜力评分(0-100)、开发周期三档估算、上线窗口评级与完整评估报告。调用前请先用 Steam/搜索/知识库工具收集竞品与品类数据（竞品至少3款，含价格/评价数/好评率/发行年份）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '项目名' },
      genre: { type: 'string', description: '品类（中文，如 肉鸽卡牌/模拟经营/幸存者like/2D平台跳跃）' },
      description: { type: 'string', description: '项目简介（玩法+亮点）' },
      dimension: { type: 'string', description: '2D 或 3D' },
      scope: { type: 'string', description: '小型/中型/大型' },
      team_size: { type: 'integer', description: '开发人数' },
      experience: { type: 'string', description: '团队经验：新手/有经验/资深' },
      competitors: { type: 'array', description: '竞品数据', items: { type: 'object', properties: { appid: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number', description: '人民币价格' }, reviews: { type: 'integer' }, positive_pct: { type: 'number', description: '好评率0-100' }, release_year: { type: 'integer' }, peak24h: { type: 'integer' } }, required: ['name'] } },
      releases_by_year: { type: 'object', description: '该品类近年新游发行数量，如 {"2024":120,"2025":150,"2026":180}' },
      upcoming_count: { type: 'integer', description: '即将推出的同类竞品数' },
      top_game_age_months: { type: 'integer', description: '品类头部爆款上线至今月数' },
      chinese_share: { type: 'number', description: '竞品支持中文的比例 0-1' },
      trend_note: { type: 'string', description: '趋势补充说明' },
    },
    required: ['name', 'genre', 'description'],
  },
  handler: async (a) => {
    const brief = {
      name: a.name,
      genre: a.genre,
      description: a.description,
      dimension: a.dimension ?? '',
      scope: a.scope ?? '',
      teamSize: a.team_size ?? 1,
      experience: a.experience ?? '有经验',
      market: {
        genre: a.genre,
        competitors: (a.competitors ?? []).map((c) => ({
          appid: c.appid,
          name: c.name,
          price: c.price,
          reviews: c.reviews,
          positivePct: c.positive_pct,
          releaseYear: c.release_year,
          peak24h: c.peak24h,
        })),
        releasesByYear: a.releases_by_year ?? {},
        upcomingCount: a.upcoming_count ?? 0,
        topGameAgeMonths: a.top_game_age_months ?? null,
        chineseShare: a.chinese_share ?? null,
        description: a.description,
        trendNote: a.trend_note ?? '',
      },
    };
    const out = runEvaluation(brief);
    // 持久化：项目档案 + 评估记录（关联会话，可从项目档案回看对话）
    const slug = (brief.name || 'project').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || `p${Date.now()}`;
    upsertProject({ slug, name: brief.name, description: brief.description, genre: brief.genre, status: '已评估' });
    addEvaluation({ projectSlug: slug, version: 1, scores: out.market, devTime: out.dev, window: out.window, report: out.report, meta: { brief, session: ctx.session ?? null } });
    addInsight({
      content: `项目《${brief.name}》评估：市场潜力 ${out.market.total}/100（${out.market.letter}），窗口 ${out.window.rating}，基准工期 ${out.dev.months.expected} 个月`,
      category: '项目评估',
      tags: `${brief.genre},立项评估`,
      sourceType: 'evaluation', sourceRef: slug,
      weight: 0.6,
    });
    invalidate();
    return out;
  },
};

const projectTools = [
  {
    name: 'project_list',
    description: '列出本地项目档案（项目名 / 品类 / 建档时间），用于了解用户评估过哪些项目。',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ projects: listProjects().map((p) => ({ name: p.name, slug: p.slug, genre: p.genre, created_at: p.created_at })) }),
  },
  {
    name: 'project_report',
    description: '读取本地项目档案中某项目的**最近一次评估报告全文**（按项目名/关键词模糊匹配）。用户说「输出项目X的评估结论」「回顾项目X的报告」时必须用它读取报告后再复述结论，不要凭记忆猜测。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '项目名或关键词' } }, required: ['name'] },
    handler: async (a) => {
      const rows = listProjects();
      if (!rows.length) return { error: '项目档案为空（还没有评估过项目）' };
      const key = String(a.name || '').trim();
      const hit =
        rows.find((p) => p.name === key) ||
        rows.find((p) => key && (p.name.includes(key) || p.slug.includes(key) || key.includes(p.name))) ||
        rows[0];
      const evals = listEvaluations(hit.slug, 1);
      return {
        project: hit.name,
        slug: hit.slug,
        genre: hit.genre,
        created_at: hit.created_at,
        report: evals[0]?.report ?? hit.latest_eval ?? '(无报告)',
      };
    },
  },
];

export const TOOLS = [...steamTools, ...biliTools, ...webTools, ...knowledgeTools, ...projectTools, evaluateTool];

export const toolDefs = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export async function runTool(name, args, ctx = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `未知工具: ${name}` };
  try {
    const result = await tool.handler(args, ctx);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: truncate(String(e.message || e), 500) };
  }
}

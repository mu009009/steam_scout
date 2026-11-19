---
name: steam-market-scout
description: Steam 游戏市场调研与立项评估 Agent。基于实时 Steam 商店数据（新游发行趋势/热销竞品/即将上线/在线人数）、B 站 UP 主「Gaby学姐说」的方法论知识库、本地项目档案，回答游戏立项问题、评估项目市场潜力与开发周期、评估上线窗口时机，并能读取历史评估结论与导出 PDF 报告。适用于独立游戏/小团队的"这个项目值不值得做、多久能上线、现在进场还来不来得及"类决策。
---

# Steam 市场侦察兵（SteamScout）Agent Skill

一个**本机运行**的 Steam 市场调研 Agent：聊天窗交互 + 实时数据采集 + 本地知识库 + 立项评估引擎。

## 何时使用本 Skill

- 用户问"我这个游戏想法值不值得做 / 市场潜力如何"
- 用户问"这个品类现在还能进场吗 / 多久能上线 / 什么时候上线最好"
- 用户要**竞品分析、品类趋势、爆款案例复盘**
- 用户要**回顾某个已评估项目的结论**或**导出评估报告**

## 运行方式

**两种形态（同一套提示词与评估引擎）：**

| 形态 | 启动 | 能力 |
|---|---|---|
| **① 单文件版** | 浏览器双击打开项目根目录的 `index.html`（无需 Node） | LLM 直连对话 + 内置知识库（117 条方法论）+ 开发周期/上线窗口规则评估 + 导出 PDF；**无实时数据** |
| **② 完整版** | `node server.mjs`（或 Windows 双击 `start.bat`） | 全部能力：实时 Steam/B站数据、SQLite 知识库与项目档案、多对话、每日复盘、数据盘点 |

单文件版会自动探测 `http://127.0.0.1:8792/api/health`：服务在跑则升级为完整模式（服务端已开放 CORS）。

```bash
node server.mjs                        # 启动完整版（默认 http://127.0.0.1:8792）
node cli.mjs "评估立项：《XXX》2D 肉鸽卡牌，2人团队，值不值得做？"   # 一次性 CLI
node cli.mjs                           # 交互式 REPL
node scripts/build_standalone.mjs      # 重新生成单文件版 index.html
```

- 零依赖：只需 Node.js ≥ 22（内置 `node:sqlite`、`fetch`、`http`），无需 npm install
- 配置：**只需要一个 OpenAI 兼容的 LLM API Key**（Steam/B站/搜索均为公开接口，无需其它 Key）
  - 网页「⚙️ 配置 LLM API」向导，或 `POST /api/llm-config {baseUrl, model, apiKey, test:true}`（自动写回 `.env` 并即时生效）
  - 或编辑 `.env`：`DEEPSEEK_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `PORT`
- Windows 双击 `start.bat`（自动清理端口占用后启动）；macOS/Linux 直接 `node server.mjs`
- HTTP API：`POST /api/chat`（SSE 流式事件）、`GET /api/history?session=`、`GET /api/sessions`、`GET /api/projects`、`GET /api/stats`、`GET /api/data-inventory`、`GET|POST /api/llm-config`、`POST /api/feedback`、`POST /api/delete-session`、`POST /api/delete-project`、`POST /api/digest-now`

## 核心工作流

### 1) 立项评估（自动触发，无需手动点按钮）

触发词包含：`立项 / 评估 / 值不值得做 / 能不能做 / 做多久 / 多久上线 / 市场潜力 / 时机 / 还能进场吗 / 红海 / 饱和`

固定 4 步流水线（确定性流程，非 LLM 自由发挥）：
1. **理解项目**：LLM 解析出 `{name, genre, dimension, scope, teamSize, experience}`
2. **采集市场数据**：品类标签定位（含关键词反推细分标签）→ 新品发行趋势（最多 300 条按年聚合）→ 热销竞品详情（价格/评价数/好评率/在线峰值）→ 即将上线数量 → Bing 搜索 + B 站评测热度 → 知识库检索
3. **评分与窗口**：六维市场潜力评分（需求规模 25% / 竞争强度 20%* / 增长趋势 20% / 商业化空间 15% / 平台匹配度 10% / 差异化空间 10%）+ 开发周期三档估算 + 上线窗口评级（优/良/险/闭）
   - \*竞争强度**得分越高=竞争越小（越蓝海）**
   - 每维度带状态：`✅数据充足 / ⚠️部分数据 / ❌无数据(按中性50分) / ➖无显著信号`
4. **报告 + 专家解读**：报告核心先出，专家解读流式追加；同时写入项目档案（`projects` / `evaluations` / `项目评估`洞察）

### 2) 输出项目结论（读档案，不重跑评估）

触发词：`输出/回顾/查看/读取/导出 + 项目/档案 + 结论/报告/评估结果`
→ 判定为**对话模式**（绝不触发新评估），调用 `project_list` + `project_report` 读取档案原文后复述结论。

### 3) 市场调研（自由问答）

其余问题走 ReAct 工具调用循环（单轮工具调用上限 14 次），自主选择工具收集证据后回答。

### 4) 持续学习进化

- 每日 9 点自动市场复盘：Steam 热销榜快照对比 + 行业新闻 + 同步 UP 主新视频 → 写入 `复盘报告` 洞察
- 复盘后 LLM 自动生成 2 个调研问题进入队列，每日限量自动调研
- 对话/评估结论异步蒸馏为知识洞察（去重加权）

## 工具清单（工具名 / 用途 / 关键参数）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `steam_store_search` | 商店列表：新游/热销/即将推出/好评榜 | `tag_name` 或 `term`、`sort`(released_desc/coming_soon/topselling/reviews)、`limit` |
| `steam_app_details` | 游戏详情（价格/发行日期/语言/推荐数） | `appid` |
| `steam_app_reviews` | 好评率汇总 | `appid` |
| `steam_search` | 关键词搜游戏 | `term` |
| `steam_charts` | SteamCharts 当前/24h峰值/历史峰值在线 | `appid` |
| `steam_app_tags` | 游戏热门用户标签 | `appid` |
| `steam_featured` | 首页橱窗（热销/新品/即将推出） | — |
| `bili_search` | B 站视频搜索（评测/案例热度） | `keyword` |
| `bili_up_videos` | UP 主视频列表（默认 Gaby学姐说 mid=3546782527130177） | `mid`、`limit` |
| `bili_video_info` / `bili_video_subtitle` / `bili_video_comments` | 视频详情 / AI 字幕 / 热评 | `bvid` |
| `web_search` | Bing 搜索（中文优先） | `query`、`limit` |
| `web_fetch_page` | 网页正文提取 | `url` |
| `kb_search` / `kb_list` / `kb_stats` / `kb_add_insight` | 本地知识库检索/列/统计/写入 | `query`、`category`、`content` |
| `project_list` / `project_report` | 项目档案列表 / 读取某项目评估报告全文 | `name`（模糊匹配） |
| `evaluate_project` | 评估引擎（六维评分+工期+窗口，写入档案） | `name`、`genre`、`description`、`competitors[]`、`releases_by_year`、`upcoming_count` 等 |

## 数据与存储（全部本地）

```
data/scout.db  ← SQLite
  insights       知识洞察（UP主观点/市场数据/调研结论/复盘报告/项目评估）
  sources        B 站视频等原始来源
  conversations  对话记录（session 分组，支持多对话）
  projects       项目档案（slug/名称/品类/latest_eval 报告）
  evaluations    评估记录（scores/dev_time/window/report/meta.session 关联会话）
  snapshots      市场快照（热销榜对比用）
  feedback / research_queue / meta
```

## 输出约定（给上层 Agent / 用户）

- 回答用**中文 Markdown**，数据需注明来源与日期
- 评分报告结构固定：项目画像 → 六维评分表（含状态列）→ 开发周期三档+里程碑+三条路线 → 上线窗口评级+策略 → 结论（GO/条件GO/NO-GO）→ 季度检查信号 → 风险情景表
- 市场未来不可预测：给**概率+情景+复查信号**，不做铁口直断
- 数据缺口必须显式说明（`附：数据缺口说明`），不要把"无数据"包装成结论
- SSE 事件类型：`phase / status / tool / reasoning / delta / report / scores / done / error`

## 已知限制与注意事项

- SteamSpy / SteamDB 被 Cloudflare 拦截（已改用官方 API + 商店搜索页 + SteamCharts）
- B 站有风控：`-412`(HTTP 412) / `-352`(risk) / `-799`(请求过于频繁) 已内置重试与冷却；仍有概率失败，播放数据可降级
- Steam 商店接口在连续高频请求下会临时限流（已内置缓存 10 分钟 + 多级重试）
- 未配置 LLM 时：离线评估/数据采集可用，对话推理不可用
- 端口被占用时：`start.bat` 会自动清理占用进程再启动；或改 `.env` 的 `PORT`

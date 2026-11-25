# AGENTS.md — 给 AI 编码 Agent 的项目操作指南

本文件面向**在本仓库上做开发的 AI Agent**（Claude Code / Codex / 其他）。用户使用说明见 `README.md`，Agent 能力规格见 `SKILL.md`。

## 项目定位

Steam 游戏市场调研 Agent：Web 聊天窗 + 实时数据采集 + 本地知识库 + 立项评估引擎。
**零依赖**：仅 Node.js ≥ 22 内置模块（`node:sqlite` / `node:http` / `fetch` / `node:crypto`），**不要引入 npm 包**。

## 快速开始

```bash
node server.mjs                 # 启动（端口取 .env 的 PORT，其次 config.json）
node cli.mjs "问题"             # 一次性问答
node cli.mjs                    # REPL
node scripts/selftest.mjs       # 模块自检（网络限流时会失败，属外部因素）
node scripts/encoding_audit.mjs # 编码审计（U+FFFD 检查）
```

## 目录职责

```
server.mjs             HTTP 服务：SSE 聊天、静态 UI、会话/项目/删除/复盘接口
cli.mjs                命令行入口
src/config.mjs         .env + config.json 配置加载（根目录相对路径）
src/db.mjs             SQLite schema + DAO（insights/sources/conversations/projects/evaluations/snapshots/...）
src/retriever.mjs      中文倒排索引（CJK 二元组 + TF-IDF）检索知识库
src/llm.mjs            OpenAI 兼容客户端（流式 SSE 解析、工具调用增量拼装、推理模型兜底）
src/agent.mjs          SYSTEM_PROMPT、detectMode、ReAct 循环、立项评估流水线、观点蒸馏、建议按钮生成
src/evaluator.mjs      评分引擎（六维+状态/缺口）、开发周期基准、上线窗口、报告模板
src/gantt.mjs          周级甘特图排期引擎（人日估算 + 角色产能 + 依赖调度 + Gate + 档期判定 + 打印版 HTML）
src/genre-tags.mjs     中文品类 → Steam 标签 ID 静态词表（ID 均已与官方字典逐个核对）
src/toolcall-repair.mjs 修复「模型把工具调用写成正文」（DSML 等）的解析与流式过滤
src/evolution.mjs      市场快照/每日复盘/UP主同步/自动调研队列/调度器
src/tools/*.mjs        steam / bilibili(wbi 签名+风控重试) / websearch(Bing) / knowledge / 项目档案工具
src/ingest/seed.mjs    B 站 UP 主内容播种（--full / --distill）
web/                   聊天 UI（原生 JS，无构建步骤；index.html / app.js / style.css）
scripts/               自检、编码审计、分享打包（pack_share.ps1 带脱敏）
```

## 关键不变量（改代码前必读）

1. **detectMode 优先级**：档案读取类 → chat；甘特图/排期类（甘特/排期/周计划/档期/里程碑拆解）→ plan（确定性排期引擎，不走市场调研）；再判断立项关键词 → eval。**不要把排期请求误判成评估、也不要反过来**。旧序号顺延。
2. **LLM 流式**：`deepseek-flash` 等推理模型会先输出 `reasoning_content`；流式正文为空时必须回退非流式重试（见 `llm.mjs` 末尾）。
3. **工具注册**：新增工具 = 在 `src/tools/*.mjs` 定义 `{ name, description, parameters, handler }`，并在 `src/tools/index.mjs` 的 `TOOLS` 数组注册；`handler(args, ctx)` 的 `ctx` 含 `{ emit, session }`。
4. **评估归档**：`evaluate_project` 与 eval 流水线都要写 `projects` + `evaluations`（`meta.session` 关联当前会话）+ `项目评估` 洞察。
5. **工具调用上限**：`config.json` → `agent.maxToolCalls`（默认 14），到顶后不再提供 tools 强制收尾。
6. **前端建议按钮**：随消息持久化在 `conversations.meta.suggestions`，`/api/history` 会解析 `meta` 返回。

## Windows 特有坑

- **.bat 文件**：只用 ASCII 内容 + CRLF 换行（cmd 按 OEM 码页解析，中文易被切坏）；`start.bat` 已内置端口清理逻辑。
- **.ps1 文件**：Windows PowerShell 5.1 需要 **UTF-8 BOM**，否则中文乱码报错（`pack_share.ps1` 已带 BOM，编辑后需重新加）。
- **控制台输出**：`pwsh` 捕获原生程序输出时中文可能显示为乱码，属控制台编码现象，不代表程序错误（用 `encoding_audit.mjs` 做权威判断）。
- **端口僵尸**：`job_kill` 只杀包装进程，node 子进程可能残留并占端口；用 `netstat -ano` 找 PID → `Stop-Process -Id <pid>` 定点清理，勿无差别杀 node。

## 外部依赖与限流

- Steam 商店 API/搜索页限流：已内置 10 分钟内存缓存 + 4 次重试（递增退避）。连续测试后短暂 `fetch failed` 属正常。
- B 站风控：`-412` / `-352` / `-799` 已内置重试 + 45s 冷却；仍需低频访问。
- Bing 偶发人机验证：`bingSearch` 内置一次重试。

## 测试清单（改完必跑）

```bash
node --check <改动文件>.mjs        # 语法
node scripts/selftest.mjs         # 数据层/Steam/B站/搜索/评估引擎
node scripts/encoding_audit.mjs   # 编码
# 端到端（需要服务在跑）：POST /api/chat 观察 SSE 事件序列
#   期望 eval：phase×4 → status/tool → scores → report → delta → done
#   期望 输出项目结论：无 phase，出现 project_list/project_report 工具，内容注明"读自档案"
#   期望 plan（甘特图）：信息不全 → phase×1/2 + delta(追问)；信息够 → phase×2 + plan + report + done
```

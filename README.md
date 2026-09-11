# PeopleFlow 企业入职智能执行平台

一个可本地运行的「Plan + Skill + Tool + Executor」企业入职助手 MVP。它用本地 JSON 模拟员工、任务、联系人、制度与培训数据，支持可视化执行链路、Skill 热配置、单 Skill 测试、强制风控审核与完整执行日志。

## 首版工作区

首页现在默认进入员工端，顶部切换三个工作区；浏览器前进、后退与旧管理链接继续可用。

- **员工端**：问问助手（保存并继续会话、回答依据、申请人工协助）、我的待办（按员工筛选、完成状态、前置事项、咨询办理方式）、处理进度（受理状态、负责人和处理结果）。
- **企业管理端**：成员与分工、知识库、办事配置（入职事项与联系人）、员工请求、会话与反馈、用量与效果。员工请求关闭前必须填写结果，回复可在员工端查看。
- **高级配置**：原有运行调试、Planner、Skill、Tool、自动评测、执行日志及模型配置。

当前使用模拟员工身份和单企业数据。工作区划分不代表认证或权限隔离；真实账号、租户隔离与角色授权仍需单独实现。员工待办的完成状态来自现有业务记录，首版不提供员工自行确认完成的入口。处理结果通过员工刷新页面查看，尚无外部消息推送。

数据修改复用本地 JSON / 云端 D1 适配；新增接口为 /api/employee-workspace/:employeeId 和 /api/enterprise-workspace。便携版会把同源 /api 请求转发给本地 API，避免 UI 构建目录影响数据定位。

本地启动仍使用“启动企业入职助手.bat”，源代码修改后先执行 npm run build。验证：npm run typecheck、npm run test:unit、node --test tests/rendered-html.test.mjs、node tests/portable-smoke.mjs。

## 环境要求

- Node.js 22.13+
- pnpm 10+（也可使用 npm 安装）
- Windows、macOS 或 Linux

## 安装与启动

```bash
pnpm install
copy .env.example .env
pnpm dev
```

启动后访问 `http://localhost:3188`。本地 API 默认运行在 `http://localhost:8787/api`。`pnpm dev` 会同时启动前端与 API 服务。

生产构建：

```bash
pnpm build
pnpm start
```

## 配置大模型

复制 `.env.example` 为 `.env`，填写兼容 OpenAI Chat Completions 的配置：

- `LLM_API_KEY`：API Key
- `LLM_BASE_URL`：API 基础地址
- `LLM_MODEL`：默认模型名
- `PORT`：前端端口
- `API_PORT`：本地 API 端口
- `NEXT_PUBLIC_API_BASE_URL`：浏览器访问的 API 地址

未填写 `LLM_API_KEY` 或 API 调用失败时，系统会自动回退到确定性的 Mock 模式，完整演示规划、查询、执行、回复与风控链路。

## 页面

- Agent 执行：选择模拟员工、输入问题、查看可用能力、Planner 计划、逐步输入输出、最终回复与风控结果。
- 会话中心：查看历史多轮对话、继续追问、评价回答、归档和转人工。
- RAG 知识库管理：上传 PDF、PPTX、DOCX、Markdown、TXT 或 JSON，自动提取正文，人工复核后发布；支持文档切片、关键词与向量混合检索、页码/幻灯片来源定位和检索预览。
- Skill 管理：查看六个内置 Skill，启用或禁用，并查看模型参数。
- Skill 编辑：编辑名称、描述、Prompt、模型、temperature、max tokens 与启用状态。
- Skill 测试：单独运行一个已启用 Skill，保存最近一次测试输入输出。
- Tool 管理：查看、启停和编辑 Tool 名称、描述及数据源配置。
- Tool 测试：使用自定义输入 JSON 直接运行本地确定性 Tool，并保存最近测试结果。
- 执行日志：查看历史执行并回到完整 Trace。
- 自动评测中心：运行 100 条核心用例和 Bad Case，失败用例可一键回流，质量门禁覆盖总体、路由和风险准确率。
- 运营看板：查看问答趋势、用户满意度、路由分布、风险、安全事件、知识缺口与 Tool 性能。

## 示例提问

- 我入职第一天需要做什么？
- 我需要准备哪些入职材料？
- 我的电脑和账号什么时候可以领取？
- 公司请假制度是什么？
- 我的入职培训有哪些？
- 我的社保、公积金什么时候开始缴纳？
- 我应该联系谁办理工位和门禁？

## 本地 JSON 数据

全部数据位于 `data/`：

- `employees.json`：10 名跨部门、岗位与阶段的模拟员工。
- `onboarding_tasks.json`：30 条通用及岗位入职任务，含优先级、依赖、负责人和期限。
- `contacts.json`：HR、IT、行政、培训、财务、信息安全与部门负责人。
- `policies.json`：员工手册、考勤、请假、报销、信息安全、社保公积金、试用期等当前有效制度。
- `trainings.json`：通用、岗位、信息安全、企业文化和部门培训。
- `skills.json`：可热更新的 Prompt、模型参数、状态和最近测试。
- `tools.json`：Tool 描述、状态与本地数据源。
- `execution_logs.json`：最近 100 次执行的计划、步骤输入输出、回复和风控结果。
- `knowledge_documents.json`：可上传、启停和版本化的企业知识文档。
- `conversation_feedback.json`：用户对助手回复的有帮助/需改进评价。
- `security_events.json`：敏感请求的分类、动作与审计记录。

JSON 写入使用临时文件后原子替换，降低保存过程中数据损坏的风险。

## Skill 配置机制

`server/skill-registry.mjs` 在每次规划和执行时读取最新的 `skills.json`，因此后台保存后无需重启即可生效。Planner 只允许生成已存在且启用的 Skill；Executor 会再次校验状态，即使手动传入已禁用 Skill 也会拒绝执行。

六个内置 Skill：问题结构化、任务决策、流程解释、制度问答、沟通话术、合规与风险审核。每个 Skill 都可独立配置模型、temperature、max tokens 和 Prompt。

## Tool 配置机制

`server/tool-registry.mjs` 负责 Tool 注册与调用。Tool 只读取本地 JSON 或运行确定性代码，模型不会生成员工状态、制度原文、联系人、培训、完成率、逾期或依赖事实。

六个本地 Tool：员工信息、入职任务、联系人、制度知识库、培训计划、任务状态计算。联系人查询按当前员工部门范围过滤；制度查询只返回当前生效版本。

另有 `run_coze_workflow_7659350798523416603` Tool，用于运行 Coze 工作流 `7659350798523416603`。输入为 `user_id`、`CONVERSATION_NAME`、`USER_INPUT`，输出为结束节点的 `answer`、`status`、`risk_level`。


## Planner 与 Executor

1. Planner 根据问题识别任务、制度、培训和联系人需求。
2. 强制先查询员工身份；按主题插入必须的 Tool。
3. Executor 按依赖顺序逐步执行，所有 Tool 输出进入后续 Skill 输入。
4. 回复生成 Skill 只使用查询结果生成员工侧内容。
5. 最后强制运行合规与风险审核；不通过时修正后再返回。
6. 全部计划、输入、输出、耗时、模式和风险结果写入执行日志。

## 目录结构

```text
app/                 前端页面与样式
data/                本地 JSON 数据库
server/
  planner.mjs        规则约束 Planner
  executor.mjs       逐步执行器
  skill-registry.mjs Skill 注册与热加载
  tool-registry.mjs  Tool 注册与调用
  json-store.mjs     JSON 原子读写
  llm.mjs            大模型 API 与 Mock 回退
  risk-review.mjs    确定性风险兜底
  logger.mjs         执行日志
scripts/             前后端联合启动脚本
```

> 所有人员、邮箱、流程和制度均为产品演示用模拟数据，不代表任何真实企业。

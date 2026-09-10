# PeopleFlow 入职助手 → 多租户 SaaS（Cloudflare 托管）升级方案

> 文档状态：草案 v0.1（待评审）
> 已确认决策：方向 A（多租户托管 SaaS）｜运行形态 Cloudflare（Workers + D1 + R2）｜本次仅产出方案文档，不改代码
> 配套代码库版本：企业入职助手 v1.6.0（RAG 知识库版）

---

## 1. 现状盘点：可复用资产与差距

### 1.1 架构事实（来自对现有代码的核对）

| 层 | 现状 | 证据 |
|---|---|---|
| 前端 | Next.js(vinext)/React 19，员工问答、会话、RAG 知识库、Skill/Tool 管理、评测、看板、admin 后台 | `app/*` |
| API | 单入口 Node 风格 HTTP 路由，挂载于 Worker `/api/*` | `server/index.mjs`（734 行路由表） |
| 执行引擎 | Planner → Skill（热配置热加载）→ Tool（确定性本地数据源）→ 风控 → 日志 | `server/planner.mjs`、`executor.mjs`、`skill-registry.mjs`、`tool-registry.mjs` |
| 数据层 | **双后端 JSON 文档存储**：本地 `data/*.json` 或 D1 `json_documents(name,value,updated_at)` 表，带种子回填与原子写 | `server/json-store.mjs` |
| 文件层 | 上传文档走 R2，`r2://` 指针抽象 | `server/runtime-storage.mjs`、`knowledge-service.mjs` |
| 平台化能力 | 模型 Provider 配置/切换、配置导出导入（防密钥）、Skill/Tool/Plan 版本化、Token 用量监控、隐私脱敏与本人访问边界、评测中心（100 用例 + 30 Bad Case）、安全事件审计、转人工 | `server/llm-config-service.mjs`、`config-service.mjs`、`versioning.mjs`、`token-usage.mjs`、`privacy.mjs`、`evaluation.mjs`、`security_events.json` |
| 部署形态 | `SITE_MODE=private-full` 口令登录保护 / `public-showcase` demo 模式；Worker 内 HMAC 会话 Cookie、本地 host 直通 | `worker/index.ts` |
| 打包 | Windows 本地安装包、launcher/portable/release 冒烟测试 | `scripts/*`、`tests/*` |

### 1.2 SaaS 化差距（本方案要补的洞）

1. **无租户隔离**：所有租户共享同一份文档键空间（`employees.json`、`policies.json`……），无法同时服务两家企业。
2. **无账号体系**：只有全局口令（`PRIVATE_ACCESS_PASSWORD`），无注册、登录、角色、邀请、组织。
3. **无平台运营端**：不能开通/停用租户、配套餐、看用量、发邀请。
4. **无计量计费**：只有 Token 用量记录，无按租户聚合与账单。
5. **无对外边界**：无租户级 API Key / 嵌入能力。

---

## 2. 目标架构（一次到位、分两代落地存储）

```text
                          Cloudflare (workers.dev / 自定义域)
┌────────────────────────────────────────────────────────────────┐
│  Worker 入口（扩展自 worker/index.ts）                            │
│   ├─ 平台域名 www.peopleflow.app  → 租户注册 / 登录 / 公开页      │
│   ├─ 租户域名  acme.peopleflow.app → 租户内体验（员工/HR 管理）    │
│   └─ 同一 Worker：认证中间件 → 租户上下文 → API 路由               │
├────────────────────────────────────────────────────────────────┤
│  D1（单库多租户，推荐）                                           │
│   ├─ json_documents_v2(tenant_id, name, value, updated_at)      │  ← 一代：业务零侵入
│   ├─ 规范化表：tenants / users / memberships / invitations /    │  ← 二代：规模期
│   │             quota_plans / usage_meter / billing_ledger       │
│  R2（文件，键空间加租户前缀 tenant_id/...）                        │
│  KV（可选：会话、限流、邮箱验证码）                                 │
│  Queues / Cron（可选：月度结算、用量聚合）                         │
└────────────────────────────────────────────────────────────────┘
外部：LLM Provider（平台统一 Key + 可选租户 BYOK）｜Coze 工作流｜邮件服务（邀请/验证码）
```

**关键决策（推荐，待你确认，见 §10）**：采用**单 D1 库 + 租户列**，而非每租户独立 D1——D1 绑定是静态的，Worker 无法按请求动态切换 binding，动态多库要按租户拆 Worker/子域，运维成本高且现阶段无必要。

---

## 3. 两代存储演进（本方案的核心技术路线）

### 3.1 为什么可以分代

你所有业务代码只通过 `readJson(name)/writeJson(name)` 访问"数据库"，且 Worker 内已由 `withRuntimeStorage({db, files})` 提供 D1/R2。这意味着：

> **只要让"租户上下文"进入存储键空间，整个执行引擎、Skill/Tool、知识库、评测、看板在逻辑上就自动按租户隔离了。**

### 3.2 一代（快速闭环）：文档库加租户维度

- 新表（迁移后替换旧 `json_documents`）：
  ```sql
  CREATE TABLE json_documents_v2 (
    tenant_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, name)
  );
  ```
- 数据层改造最小集：
  - `AsyncLocalStorage` 中增加 `tenant_id`（复用现有 `runtime-storage.mjs` 机制）。
  - `json-store.mjs` 读写路径改为 `scopedKey = tenant_id ? `${tenant_id}/${name}` : name`（云库与本地库同规则）。
  - 平台自身（模板、平台配置）落在**系统租户** `tenant_id = '__platform__'`。
- **业务代码改动量 ≈ 0**：planner/executor/skill/tool/knowledge/evaluation 全部自动租户化。
- 遗留演示数据统一迁入 `demo` 租户（供测试与公开 demo 页使用）。

### 3.3 二代（规模期）：核心实体规范化

当单租户数据量或并发上来后，将高频实体逐步迁移到规范化表（Drizzle + `db/schema.ts` 扩展，沿用现有 `drizzle-kit`）：

```ts
tenants        { id, name, slug, plan_id, status, settings(JSON), branding(JSON), created_at, updated_at }
users          { id, email, name, password_hash, auth_provider, provider_sub, created_at }
memberships    { tenant_id, user_id, role, status, joined_at }   // PK(tenant_id,user_id)
invitations    { id, tenant_id, email, role, token_hash, expires_at, used_at }
quota_plans    { id, name, monthly_price, feature_flags(JSON), limits(JSON) }
usage_meter    { tenant_id, date, kind, amount }                  // kind: llm_tokens/coze_calls/seats/storage_bytes
billing_ledger { id, tenant_id, plan_id, amount, currency, status, period_start, period_end, created_at }
```

迁移策略：一代期间在文档库中照常运营；二代迁移器按 `tenant_id + name` 把文档转成行，接口层先做"读新库→回退读文档"双读，验证一致后切写。

---

## 4. 租户上下文与 API 隔离（防串号是硬指标）

- 中间件职责（在 Worker 入口统一完成，`worker/index.ts` 改造）：
  1. 解析会话 Cookie → `{ user_id, tenant_id, role }`（沿用现有 HMAC 签名方案，claims 扩展即可）。
  2. 子域/路径解析租户：`acme.peopleflow.app` 或 `/org/acme/*`。
  3. 校验 `memberships`：用户确在该租户且状态正常，否则 403。
  4. `withRuntimeStorage({ db, files, tenant_id, user_id, role }, ...)` 包裹请求。
- API 层强制规则（写进测试，仿照现有 `privacy.mjs` 的 `assertSelfAccess`）：
  - 所有数据访问必须携带租户上下文；无上下文的读写一律拒绝。
  - `employees.json` 等"员工侧"数据仍执行**本人访问边界**（租户内再按角色收缩）。
- 前端所有 fetch 走统一封装的 `adminRequest/jsonRequest`（`app/admin/api.ts`）扩展：自动带会话、校验租户与角色、401 跳登录。

---

## 5. 账号体系与认证（替换全局口令）

| 阶段 | 能力 |
|---|---|
| P0 | 邮箱+密码注册；**首次注册即创建组织**（或输入邀请码加入既有组织）；登录/登出；`owner/admin/hr/employee` 四角色；邀请链接（HMAC token，过期与单次使用） |
| P1 | 密码找回（邮件验证码走 KV 限流）；会话刷新 |
| P2（预留） | 企业微信 / 飞书 / OAuth SSO；每租户可配自己的 IdP |

会话方案沿用现有 HMAC-SHA256（`signSession`），claims 改为 `v2:{userId}:{tenantId}:{role}:{expiresAt}`；Cookie 加 `Secure; SameSite=Strict`。平台运营端与租户端用不同 Cookie 命名空间与校验角色，防止越权。

---

## 6. 前端改造（尽量复用现有页面）

- 新增流程页：`/login`、`/register`、`/invite/:token`、`/org/setup`（首租户向导：填企业名 → 选模板 → 建管理员）。
- 现有页面按角色拆分挂载：
  - 员工问答/会话/知识库浏览 → `employee` 及以上
  - Skill/Tool/Planner/评测/模型配置/运营看板 → `admin` 及以上（已基本如此，AdminShell 校验角色即可）
  - 企业设置（品牌、成员、邀请、账单）→ `owner/admin`
- 新增 `/platform/*` **平台运营端**（独立于租户端）：租户列表、开通/停用、套餐分配、用量总览、系统配置（模型 Key、模板）。
- demo/showcase 页保留：改为 `demo` 租户只读实例，加"体验完整功能 → 注册"入口。

---

## 7. 企业入驻与模板实例化（SaaS 的核心增值点）

开租户时从 `__platform__` 模板批量复制（你的"配置驱动"设计让这个动作极其自然）：

```text
platform 模板（skills/tools/plans/policies/trainings/knowledge_documents 种子）
   │  深拷贝 + tenant_id 改写 + 剔除 last_test 等运行时脏字段
   ▼
新租户独立文档空间
   └─ 企业随后在后台改制度、传自己的知识库、调 Skill —— 互不影响
```

模板可版本化（复用 `versioning.mjs` 机制）：平台升级模板 → 各租户可选"跟随最新 / 保持锁定 / 合并更新"。

---

## 8. 计量、配额与计费（先计量后收费）

- **计量**：在现有 `token-usage.mjs` 基础上把记录挂上 `tenant_id`（执行上下文里已带），每日 Cron/惰性聚合写入 `usage_meter`。
- **配额**：`quota_plans.limits` 定义（席位数、月 Token、Coze 调用次、知识库文档数与存储字节、RAG 检索量）；Worker 入口按租户校验并返回 429/403 语义。
- **计费**：`billing_ledger` 先行记账（订单幂等、状态机 pending→paid/failed），支付渠道（微信/支付宝/Stripe/对公转账）以适配器接口预留，首版可只出账单不开支付。
- **成本归属决策点**（见 §10-2）：平台统一持 LLM Key、按租户计量计费，最利于首批客户快速开通；BYOK 作为高套餐/私有化选项。

---

## 9. 安全、合规与测试护栏

- **隔离测试成为硬门禁**：扩展 `tests/platform-v1.test.mjs`，新增"租户 A 读不到租户 B 的 policies/employees/会话/日志、跨租户引用被拒"用例；评测集（100 条 + 30 Bad Case）作为回归护栏保留全量跑。
- 现有能力直接复用：`privacy.mjs`（脱敏/本人访问）、`security_events.json` 审计升级为按租户审计、配置导出防密钥。
- 数据删除（《个保法》合规）：租户退订 → 冻结 → 宽限期 → 级联清除 D1/R2 键空间；提供"数据导出"给企业主。
- 限流与滥用防护：注册/登录/邀请接口按 IP 限流（KV 计数），LLM 调用按租户配额熔断。

---

## 10. 需要你拍板的开放决策点

1. **租户识别方式**：子域（`acme.peopleflow.app`） vs 路径（`/org/acme`） vs 纯登录后上下文。推荐子域+登录上下文混合（品牌感强，且 demo/公开页可共存）。
2. **LLM 成本归属**：平台统一 Key + 计量计费（推荐首版） / 租户 BYOK / 两者按套餐并行。
3. **支付渠道与区域**：先记账后接支付？用 Stripe（海外）还是微信/支付宝（国内）还是对公转账？首版是否就要真实收款？
4. **计费单位**：按月席位 / 按 Token 用量 / 混合。建议混合：基础席位费 + 用量超卖阶梯。
5. **域名与迁移**：自定义域接入（Cloudflare for SaaS）何时做；旧 `demo` 数据如何对待。
6. **存储一代/二代节奏**：是否接受"先文档库租户化快速上线、后规范化迁移"（推荐，风险最低）。

---

## 11. 分阶段路线图（每阶段含验收标准）

### Phase 0 —— SaaS 地基（核心，约占比 45%）
交付：
- D1 `json_documents_v2` 迁移 + 旧数据入 `demo` 租户
- `runtime-storage` 增加 `tenant_id/user_id/role` 上下文；`json-store` 键空间租户化
- 租户/用户/成员/邀请表（Drizzle schema + 迁移 SQL）
- 注册→建组织→邀请→登录会话（HMAC v2 claims）；替换口令页
- 平台种子模板 + 开租户复制器；`/platform/*` 运营端 MVP（租户列表、启停）
- 隔离与回归测试全量通过（现有测试 + 新增跨租户用例）

**验收**：两家以上测试企业可同时注册、数据互不可见；`pnpm test:unit` 等既有套件零回归；知识问答/RAG/评测在租户内功能与 v1.6 一致。

### Phase 1 —— 租户内体验完善
交付：企业设置页（品牌/成员/邀请/角色管理）；员工端/管理端按角色收敛；R2 文件键空间加租户前缀；知识库按租户配额。

### Phase 2 —— 计量与运营
交付：`usage_meter` 按租户聚合（复用 token-usage）；运营端用量总览与租户配额编辑；月度对账单（记账先行）。

### Phase 3 —— 商业闭环
交付：套餐与限额执行（429 语义）；支付适配器接口 + 至少一个渠道接入；退订/冻结/数据导出/清除流程。

### Phase 4 —— 可选扩展（另行立项）
交付：企微/飞书 SSO；对外 API（租户级 API Key）与可嵌入对话组件；二代规范化表迁移。

---

## 12. 与"你不想要的坑"对应的护栏总结

- 不推倒重写：一代用文档库租户化，业务代码 ≈0 改动。
- 不裸奔上线：跨租户用例入测试门禁、审计复用、限流配额先行。
- 不给运营添乱：demo/私有化/托管三形态共存（现有 `SITE_MODE` 思路扩展为 `demo | self-hosted | saas`）。

> 下一步建议：先评审 §10 的六个决策点（尤其 1/2/3），确认后我按 Phase 0 产出可评审的实施清单并开工。

# VirtuCorp 技术设计

> 基于 OpenClaw 插件体系的 AI 自治软件公司

本文档是 VirtuCorp 的技术实现方案，基于 [spec.md](./spec.md) 中的产品构想，映射到 OpenClaw 的插件机制。

---

## 一、设计原则

1. **事件驱动，非轮询**：所有 agent 行为由事件触发（GitHub webhook、定时心跳、投资人指令），不做 busy-wait
2. **GitHub 即状态机**：Issues/PRs/Milestones/Labels 是唯一的业务状态源，agent 每次启动从 GitHub 读取上下文，不依赖内存
3. **Agent 即函数**：每个角色 agent 是短生命周期的 sub-agent，按任务创建、完成即销毁，不常驻
4. **权限即架构**：通过 tool 注册 + hook 拦截实现角色权限隔离，而非依赖 prompt 约束
5. **宪法分层**：自举修改受分层治理约束，防止 agent 改写自身约束

---

## 二、OpenClaw 能力映射

| OpenClaw 机制 | VirtuCorp 用途 | 对应 API |
|---|---|---|
| Plugin Extension | VirtuCorp 整体作为一个插件 | `OpenClawPluginDefinition.register()` |
| Tool Registration | GitHub 操作工具集（Issue/PR/Label/Milestone） | `api.registerTool()` |
| HTTP Route | 接收 GitHub Webhook | `api.registerHttpRoute()` |
| Service | Sprint 定时器、预算监控 | `api.registerService()` |
| Hook: `before_prompt_build` | 注入角色 prompt + Sprint 上下文 | `api.on("before_prompt_build", ...)` |
| Hook: `subagent_spawning` | 拦截 sub-agent 创建，注入角色配置 | `api.on("subagent_spawning", ...)` |
| Hook: `subagent_ended` | 处理 sub-agent 完成事件，推进状态机 | `api.on("subagent_ended", ...)` |
| Hook: `before_tool_call` | 角色权限门控（Dev 不能 merge） | `api.on("before_tool_call", ...)` |
| Hook: `llm_output` | Token 用量统计、预算控制 | `api.on("llm_output", ...)` |
| Sub-agent (`sessions_spawn`) | CEO 派生 PM/Dev/QA/Ops 子 agent | 内置 agent tool |
| Feishu Channel | 投资人通知与指令接收 | 已内置，直接使用 |
| Auth Profiles | 多模型支持（Opus for PM, Sonnet for QA） | 配置层 |
| Heartbeat | 定期检查 stale issue、触发 sprint 事件 | `agentDefaults.heartbeat` |

---

## 三、插件结构

```
extensions/virtucorp/
├── openclaw.plugin.json          # 插件 manifest
├── package.json                  # 入口声明
├── index.ts                      # onLoad 入口，注册所有组件
│
├── config.ts                     # 配置类型定义与校验
│
├── tools/                        # Agent 可调用的工具
│   ├── github-issues.ts          # Issue CRUD + Label 管理
│   ├── github-prs.ts             # PR 创建/Review/Merge
│   ├── github-milestones.ts      # Milestone (Sprint) 管理
│   ├── github-discussions.ts     # Discussion (Retro/RFC) 管理
│   └── sprint-tools.ts           # Sprint 状态查询/推进
│
├── services/                     # 后台常驻服务
│   ├── sprint-scheduler.ts       # Sprint 生命周期定时器
│   ├── webhook-server.ts         # GitHub Webhook 处理
│   └── budget-monitor.ts         # Token 预算监控 + circuit breaker
│
├── hooks/                        # 生命周期钩子
│   ├── role-injector.ts          # subagent_spawning: 注入角色 prompt/model/tools
│   ├── context-loader.ts         # before_prompt_build: 加载 Sprint 上下文
│   ├── permission-guard.ts       # before_tool_call: 角色权限检查
│   ├── usage-tracker.ts          # llm_output: 用量追踪
│   └── task-router.ts            # subagent_ended: 完成后推进状态机
│
├── roles/                        # 各角色系统 prompt
│   ├── ceo.md
│   ├── pm.md
│   ├── dev.md
│   ├── qa.md
│   └── ops.md
│
└── lib/                          # 共享工具
    ├── github-client.ts          # gh CLI wrapper
    ├── sprint-state.ts           # Sprint 状态读写
    └── types.ts                  # 共享类型定义
```

### 插件 Manifest

```json
{
  "id": "virtucorp",
  "name": "VirtuCorp",
  "description": "AI-native autonomous software company",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "github": {
        "type": "object",
        "properties": {
          "owner": { "type": "string" },
          "repo": { "type": "string" },
          "webhookSecret": { "type": "string" }
        },
        "required": ["owner", "repo"]
      },
      "sprint": {
        "type": "object",
        "properties": {
          "durationDays": { "type": "number", "default": 14 },
          "autoRetro": { "type": "boolean", "default": true }
        }
      },
      "budget": {
        "type": "object",
        "properties": {
          "dailyLimitUsd": { "type": "number", "default": 5 },
          "circuitBreakerRetries": { "type": "number", "default": 3 }
        }
      },
      "roles": {
        "type": "object",
        "properties": {
          "pm": { "type": "object", "properties": { "model": { "type": "string" } } },
          "dev": { "type": "object", "properties": { "model": { "type": "string" } } },
          "qa": { "type": "object", "properties": { "model": { "type": "string" } } },
          "ops": { "type": "object", "properties": { "model": { "type": "string" } } }
        }
      }
    },
    "required": ["github"]
  },
  "uiHints": {
    "github.owner": { "label": "GitHub Owner", "placeholder": "your-username" },
    "github.repo": { "label": "Target Repo", "placeholder": "stock-trading-system" },
    "github.webhookSecret": { "label": "Webhook Secret", "sensitive": true },
    "budget.dailyLimitUsd": { "label": "Daily Budget (USD)", "placeholder": "5" }
  }
}
```

---

## 四、Agent 拓扑

### 核心模型：CEO + 角色 Sub-agent

```
投资人 (Feishu)
    │
    ▼
CEO Agent (主 session，长驻)
    │  事件驱动：webhook / heartbeat / 投资人指令
    │
    ├─ sessions_spawn("pm", task) ──→ PM Sub-agent (短生命周期)
    │                                    └─ 操作: Issue/Milestone CRUD
    │
    ├─ sessions_spawn("dev", task) ──→ Dev Sub-agent (短生命周期)
    │                                    └─ 操作: git branch → code → PR
    │
    ├─ sessions_spawn("qa", task) ──→ QA Sub-agent (短生命周期)
    │                                    └─ 操作: PR Review → Approve/Reject
    │
    └─ sessions_spawn("ops", task) ──→ Ops Sub-agent (短生命周期)
                                         └─ 操作: README/Changelog/Release
```

**为什么不用多个常驻 agent？**

- Sub-agent 模式天然隔离上下文，不会互相污染
- 按任务创建/销毁，成本可控（不活跃时零消耗）
- OpenClaw 已内置 `subagents.maxConcurrent`、`maxSpawnDepth`、`maxChildrenPerAgent` 等限制
- 每个 sub-agent 通过 `subagent_spawning` hook 自动注入角色配置，CEO 只需声明 "我需要一个 PM 来做 X"

### CEO Agent 的本质

CEO 不是一个"聪明的决策者"，而是一个 **事件驱动的状态机调度器**。它的 system prompt 定义：

- 公司使命和当前项目描述
- 角色目录：何时召唤哪个角色
- 决策框架：质量 > 速度 > 范围
- 升级规则：什么情况下 escalate 给投资人

CEO **不** 写代码、**不** review PR、**不** 写文档。它只做三件事：

1. 读 GitHub 状态，理解当前态势
2. 决定下一步行动，选择角色
3. 用 `sessions_spawn` 派生 sub-agent 执行

---

## 五、事件驱动架构

### 事件源

| 事件源 | 触发方式 | 典型场景 |
|---|---|---|
| GitHub Webhook | `registerHttpRoute("/vc/webhook")` | PR 创建 → 触发 QA；CI 失败 → 创建 Bug Issue |
| Heartbeat | `agentDefaults.heartbeat` | 每小时检查 stale issue、stuck PR |
| Sprint Timer | `registerService("sprint-scheduler")` | Sprint 结束触发 Retro |
| 投资人指令 | Feishu channel message | `approve sprint-4`、`pivot: 加入新功能` |

### 事件处理流程

```
事件到达
  │
  ▼
CEO Agent 被唤醒
  │
  ├─ 读取 GitHub 状态（open issues, PRs, milestones）
  ├─ 读取 Sprint 元数据（当前 sprint, 目标, 预算余量）
  │
  ▼
决策：需要什么角色做什么事？
  │
  ├─ "有 ready-for-dev 的 issue"  → spawn Dev sub-agent
  ├─ "有新 PR 等待 review"       → spawn QA sub-agent
  ├─ "Sprint 到期"               → spawn PM sub-agent (Retro)
  ├─ "投资人说 pivot"            → spawn PM sub-agent (Re-plan)
  ├─ "CI 失败"                   → spawn Dev sub-agent (Fix)
  └─ "无事可做"                  → 返回，等待下次事件
```

### Webhook 处理

```typescript
// services/webhook-server.ts
api.registerHttpRoute({
  path: "/vc/webhook",
  auth: "plugin",  // 插件自行验证签名
  handler: async (req, res) => {
    const event = req.headers["x-github-event"];
    const payload = await parseBody(req);

    // 验证 webhook secret
    if (!verifySignature(payload, config.github.webhookSecret)) {
      res.writeHead(401);
      res.end();
      return;
    }

    // 将 GitHub 事件转化为 CEO 可理解的消息
    const message = translateWebhookToTask(event, payload);
    if (message) {
      // 通过 gateway method 发送给 CEO session
      await api.runtime.sendMessage(ceoSessionKey, message);
    }

    res.writeHead(200);
    res.end();
  },
});
```

---

## 六、工具集设计

### GitHub 工具注册

所有工具以 `vc_` 前缀命名，避免与 OpenClaw 内置工具冲突。

```typescript
// tools/github-issues.ts
export function registerIssueTools(api: OpenClawPluginApi, config: VirtuCorpConfig) {
  const gh = createGitHubClient(config.github);

  api.registerTool((ctx: OpenClawPluginToolContext) => ({
    name: "vc_list_issues",
    description: "List GitHub issues with optional filters",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
        labels: { type: "string", description: "Comma-separated label names" },
        milestone: { type: "string", description: "Milestone title or number" },
        assignee: { type: "string" },
      },
    },
    handler: async (args) => {
      const issues = await gh.listIssues(args);
      return JSON.stringify(issues);
    },
  }));

  api.registerTool((ctx: OpenClawPluginToolContext) => ({
    name: "vc_create_issue",
    description: "Create a new GitHub issue",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        milestone: { type: "number" },
        assignees: { type: "array", items: { type: "string" } },
      },
      required: ["title", "body"],
    },
    handler: async (args) => {
      const issue = await gh.createIssue(args);
      return JSON.stringify(issue);
    },
  }));

  // vc_update_issue, vc_close_issue, vc_add_labels, vc_remove_labels ...
}
```

### 工具清单

| 工具名 | 功能 | 可用角色 |
|---|---|---|
| `vc_list_issues` | 列出 Issues | ALL |
| `vc_create_issue` | 创建 Issue | PM, Dev, QA, Ops |
| `vc_update_issue` | 更新 Issue（标题/正文/标签/指派） | PM, CEO |
| `vc_close_issue` | 关闭 Issue | PM, QA |
| `vc_create_milestone` | 创建 Milestone（Sprint） | PM |
| `vc_create_pr` | 创建 Pull Request | Dev |
| `vc_review_pr` | 提交 PR Review（approve/request_changes/comment） | QA |
| `vc_merge_pr` | 合并 PR | QA, CEO |
| `vc_create_discussion` | 创建 Discussion（Retro/RFC） | PM, Architect |
| `vc_get_sprint_state` | 查询当前 Sprint 状态 | ALL |
| `vc_report_to_investor` | 发送报告给投资人（via Feishu） | CEO |

**注意**：Dev 拥有 pi-coding-agent 内置的文件系统和 shell 工具，用于实际编码。上述工具只覆盖 GitHub 协作层。

---

## 七、Hook 编排

### 1. 角色注入 (`subagent_spawning`)

CEO 通过 `sessions_spawn` 派生 sub-agent 时，label 字段携带角色标识。hook 拦截并注入角色配置。

```typescript
// hooks/role-injector.ts
api.on("subagent_spawning", async (event, ctx) => {
  const role = parseRoleFromLabel(event.label); // e.g. "pm", "dev", "qa", "ops"
  if (!role || !VIRTUCORP_ROLES.includes(role)) return;

  const roleConfig = config.roles[role];

  // 将角色信息存入 session metadata（供其他 hook 读取）
  storeRoleMetadata(event.childSessionKey, role);

  return { status: "ok" as const };
});
```

### 2. 上下文注入 (`before_prompt_build`)

每次 agent 运行前，注入角色 prompt 和 Sprint 上下文。

```typescript
// hooks/context-loader.ts
api.on("before_prompt_build", async (event, ctx) => {
  const role = getRoleMetadata(ctx.sessionKey);
  if (!role) return; // 非 VirtuCorp session，跳过

  // 加载角色 system prompt
  const rolePrompt = await loadRolePrompt(role); // 读取 roles/pm.md 等

  // 加载当前 Sprint 上下文
  const sprintContext = await buildSprintContext(config.github);

  return {
    prependSystemContext: rolePrompt,     // 静态角色定义，可被 prompt cache
    prependContext: sprintContext,          // 动态 Sprint 状态，每次更新
  };
});
```

### 3. 权限门控 (`before_tool_call`)

基于角色限制工具调用。

```typescript
// hooks/permission-guard.ts
const ROLE_PERMISSIONS: Record<string, string[]> = {
  pm:  ["vc_list_issues", "vc_create_issue", "vc_update_issue", "vc_close_issue",
         "vc_create_milestone", "vc_create_discussion", "vc_get_sprint_state"],
  dev: ["vc_list_issues", "vc_create_issue", "vc_create_pr", "vc_get_sprint_state"],
  qa:  ["vc_list_issues", "vc_review_pr", "vc_merge_pr", "vc_close_issue",
         "vc_get_sprint_state"],
  ops: ["vc_list_issues", "vc_create_issue", "vc_create_discussion",
         "vc_get_sprint_state"],
};

api.on("before_tool_call", async (event, ctx) => {
  if (!event.toolName.startsWith("vc_")) return; // 非 VirtuCorp 工具，不拦截

  const role = getRoleMetadata(ctx.sessionKey);
  if (!role) return;

  const allowed = ROLE_PERMISSIONS[role] ?? [];
  if (!allowed.includes(event.toolName)) {
    return {
      block: true,
      blockReason: `Role "${role}" is not permitted to use ${event.toolName}`,
    };
  }
});
```

### 4. 用量追踪 (`llm_output`)

```typescript
// hooks/usage-tracker.ts
api.on("llm_output", async (event, ctx) => {
  if (!ctx.sessionKey) return;

  const role = getRoleMetadata(ctx.sessionKey);
  const usage = event.usage;
  if (!usage || !role) return;

  await budgetMonitor.record({
    role,
    tokens: usage.total ?? 0,
    model: event.model,
    timestamp: Date.now(),
  });

  // Circuit breaker：超出日预算则阻断后续调用
  if (await budgetMonitor.isDailyLimitExceeded()) {
    // 通知 CEO escalate 给投资人
    await notifyBudgetExceeded(api, ctx);
  }
});
```

### 5. 任务路由 (`subagent_ended`)

Sub-agent 完成后，推进 GitHub 状态机。

```typescript
// hooks/task-router.ts
api.on("subagent_ended", async (event, ctx) => {
  const role = getRoleMetadata(event.targetSessionKey);
  if (!role) return;

  // 清理 role metadata
  clearRoleMetadata(event.targetSessionKey);

  // 如果 sub-agent 失败，记录并可能 escalate
  if (event.outcome !== "ok") {
    await handleSubagentFailure(api, event, role);
  }
});
```

---

## 八、Sprint 生命周期

### 完整 Sprint 循环

```
Phase 1: Planning (Day 0)
  触发: 上个 Sprint 结束 或 投资人 approve
  CEO → spawn PM("plan sprint N based on retro")
  PM:
    - 读取上个 Sprint 的 Discussion (retro)
    - 创建 Milestone "Sprint N"
    - 创建 Issues，打 label: status/ready-for-dev, priority/*, type/*
    - 报告给 CEO

Phase 2: Execution (Day 1 ~ Day 13)
  触发: Heartbeat (每小时) + GitHub Webhook
  循环:
    CEO 检查 GitHub 状态:
      ├─ 有 status/ready-for-dev issue → spawn Dev("implement issue #X")
      │   Dev:
      │     - 读 Issue 描述
      │     - git checkout -b feature/issue-X
      │     - 写代码、跑测试
      │     - vc_create_pr(title, body, closes #X)
      │     - 更新 label: status/ready-for-dev → status/in-review
      │
      ├─ 有 status/in-review PR → spawn QA("review PR #Y")
      │   QA:
      │     - 读 PR diff + Issue 上下文
      │     - 跑测试套件
      │     - vc_review_pr(approve) → vc_merge_pr() → label: status/done
      │     - 或 vc_review_pr(request_changes, comments) → Dev 再次处理
      │
      └─ CI 失败 webhook → spawn Dev("fix CI failure on PR #Y")

Phase 3: Retrospective (Day 14)
  触发: Sprint timer 到期
  CEO → spawn PM("write retrospective for sprint N")
  PM:
    - 汇总：closed issues, merged PRs, open issues, 质量指标
    - vc_create_discussion(title: "Sprint N Retro", body: ...)
  CEO → spawn Ops("update changelog and README")
  Ops:
    - 读 merged PRs → 更新 CHANGELOG.md
    - 更新 README.md 如有新功能
  CEO → vc_report_to_investor(sprint_summary)
    - 生成 Board Report → 发 Feishu 给投资人

Phase 4: Review Gate (异步)
  投资人通过 Feishu 回复:
    - "approve" → CEO 进入 Phase 1，开始下个 Sprint
    - "pivot: ..." → CEO 传递给 PM 重新规划
    - "hire security-agent" → CEO 更新角色目录
    - "budget: $10/day" → 更新 budgetMonitor 配置
```

### Sprint 状态存储

Sprint 元数据存储在目标 repo 的 `/.virtucorp/sprint.json` 中：

```json
{
  "current": 3,
  "startDate": "2026-03-01",
  "endDate": "2026-03-14",
  "milestone": 5,
  "status": "executing",
  "budget": {
    "dailyLimitUsd": 5,
    "spentTodayUsd": 2.3,
    "spentSprintUsd": 18.7
  }
}
```

这个文件通过 PR 更新，本身也走 Git 历史，可追溯。

---

## 九、权限模型

### 角色权限矩阵

| 操作 | CEO | PM | Dev | QA | Ops |
|---|---|---|---|---|---|
| 创建 Issue | - | ✅ | ✅(bug only) | ✅(bug only) | ✅ |
| 更新 Issue Label | ✅ | ✅ | 部分 | 部分 | - |
| 创建 Milestone | - | ✅ | - | - | - |
| 创建 PR | - | - | ✅ | - | ✅ |
| Review PR | - | - | - | ✅ | - |
| Merge PR | ✅ | - | - | ✅ | - |
| 创建 Discussion | - | ✅ | - | - | ✅ |
| 修改代码 | - | - | ✅ | - | ✅(docs only) |
| 发送投资人报告 | ✅ | - | - | - | - |
| Spawn sub-agent | ✅ | - | - | - | - |

### 实现方式

权限通过三层保障：

1. **Tool 级**：`before_tool_call` hook 按角色白名单过滤 `vc_*` 工具
2. **Prompt 级**：角色 system prompt 明确说明"你不能做 X"
3. **GitHub 级**：GitHub branch protection rules 作为最后防线（PR 必须有 approved review 才能 merge）

---

## 十、自举机制

### 层级 A：产品自举（核心循环）

目标项目（如股票交易系统）通过 Sprint 循环持续演进：

```
Spec → PM 拆解 → Dev 实现 → QA 审查 → 合并 → PM 规划下个 Sprint → ...
```

这是 VirtuCorp 的主要价值。关键指标：
- Issue 关闭率
- PR cycle time
- 测试覆盖率
- Sprint velocity

### 层级 B：流程自举（自我优化）

Agent 在工作中发现流程问题，可以提出改进：

- Dev 发现重复工作 → 提 `type/chore` Issue 改进 CI
- QA 发现常见缺陷模式 → 提 `type/refactor` Issue 加 lint 规则
- PM 发现估算不准 → 调整下个 Sprint 的 Issue 粒度

这些改进走正常的 Issue → PR → Review → Merge 流程。

### 层级 C：元自举（自我修改）

VirtuCorp 的 agent 修改 VirtuCorp 插件本身的代码。这是最强大也最危险的能力。

#### 宪法分层治理

```
Layer 0 — 不可变层（OpenClaw 配置）
  │  插件注册、auth profiles、基础安全策略
  │  只有人类可以修改
  │
Layer 1 — 宪法层（roles/ceo.md + CONSTITUTION.md）
  │  核心规则：质量门控、预算限制、升级策略
  │  修改需要 label: needs-investor-approval + 投资人 approve
  │
Layer 2 — 角色层（roles/pm.md, roles/dev.md 等 + hooks/）
  │  角色 prompt、工具权限、hook 逻辑
  │  修改走 PR + QA review + CEO approve
  │
Layer 3 — 业务层（目标项目代码）
  │  正常的 Issue → Dev → QA 流程
  │  无额外约束
```

#### 安全约束

1. **CEO 不能修改 Layer 0 和 Layer 1**：这通过 `before_tool_call` hook 拦截对特定文件路径的写操作实现
2. **角色 prompt 修改需要双重审批**：QA review + CEO 通过 → 打 `needs-investor-approval` label → 投资人 approve 后才能 merge
3. **回滚机制**：所有修改走 Git，可以随时 `git revert`

#### 元自举的触发

当 agent 多次在同一类任务上失败（circuit breaker 触发），CEO 可以：
1. 创建 `type/meta-improvement` Issue，描述失败模式
2. Spawn Dev sub-agent 修改 VirtuCorp 插件代码
3. 修改必须通过 QA review + 投资人审批
4. 合并后重启 OpenClaw 加载新版插件

---

## 十一、配置方案

### OpenClaw 主配置 (`openclawconfig.json5`)

```json5
{
  // VirtuCorp CEO agent
  agentDefaults: {
    model: { primary: "claude-opus-4-6" },
    thinking: "high",
    heartbeat: {
      intervalMinutes: 60,
      activeHours: { start: 8, end: 22 },  // 只在工作时间活跃
    },
    subagents: {
      maxConcurrent: 3,        // 最多 3 个 sub-agent 并行
      maxSpawnDepth: 1,        // sub-agent 不能再 spawn（CEO 独占调度权）
      maxChildrenPerAgent: 5,
      runTimeoutSeconds: 600,  // 10 分钟超时
    },
  },

  // Feishu channel（投资人通道）
  channels: {
    feishu: {
      appId: "${FEISHU_APP_ID}",
      appSecret: "${FEISHU_APP_SECRET}",
      // ...
    },
  },

  // Auth profiles（多模型）
  auth: {
    profiles: {
      "anthropic-opus": {
        kind: "api_key",
        apiKey: "${ANTHROPIC_API_KEY}",
      },
      "anthropic-sonnet": {
        kind: "api_key",
        apiKey: "${ANTHROPIC_API_KEY}",
      },
      "qwen-coder": {
        kind: "api_key",
        apiKey: "${QWEN_API_KEY}",
      },
    },
  },

  // VirtuCorp 插件配置
  plugins: {
    entries: {
      virtucorp: {
        github: {
          owner: "your-username",
          repo: "stock-trading-system",
          webhookSecret: "${GITHUB_WEBHOOK_SECRET}",
        },
        sprint: {
          durationDays: 14,
          autoRetro: true,
        },
        budget: {
          dailyLimitUsd: 5,
          circuitBreakerRetries: 3,
        },
        roles: {
          pm:  { model: "claude-opus-4-6" },
          dev: { model: "qwen3-coder" },
          qa:  { model: "claude-sonnet-4-6" },
          ops: { model: "gemini-2.5-flash" },
        },
      },
    },
  },
}
```

---

## 十二、Dev Agent 的工作空间隔离

多个 Dev sub-agent 可能并行工作在不同 Issue 上，需要隔离的文件系统。

### 方案：Git Worktree

```typescript
// Dev sub-agent 启动时，在 before_prompt_build 中注入工作空间路径
api.on("before_prompt_build", async (event, ctx) => {
  const role = getRoleMetadata(ctx.sessionKey);
  if (role !== "dev") return;

  const issueNumber = getAssignedIssue(ctx.sessionKey);
  const worktreePath = path.join(WORKSPACES_DIR, `issue-${issueNumber}`);

  // 创建 git worktree
  await exec(`git worktree add ${worktreePath} -b feature/issue-${issueNumber}`, {
    cwd: PROJECT_ROOT,
  });

  return {
    prependContext: `Your workspace is at: ${worktreePath}\nYou are working on issue #${issueNumber}.\nAlways work within this directory.`,
  };
});

// Dev sub-agent 结束后，清理 worktree
api.on("subagent_ended", async (event, ctx) => {
  const role = getRoleMetadata(event.targetSessionKey);
  if (role !== "dev") return;

  const issueNumber = getAssignedIssue(event.targetSessionKey);
  const worktreePath = path.join(WORKSPACES_DIR, `issue-${issueNumber}`);

  // PR 已创建则清理 worktree（代码已在远端）
  await exec(`git worktree remove ${worktreePath} --force`, { cwd: PROJECT_ROOT });
});
```

---

## 十三、实施路线

### Phase 1：最小闭环（1-2 周）

**目标**：CEO + Dev + QA 能完成一个 Issue 的完整生命周期

实现内容：
- [ ] 插件骨架（manifest, index.ts, config）
- [ ] GitHub 工具集（`vc_list_issues`, `vc_create_issue`, `vc_create_pr`, `vc_review_pr`, `vc_merge_pr`）
- [ ] CEO 角色 prompt
- [ ] Dev 角色 prompt + worktree 隔离
- [ ] QA 角色 prompt
- [ ] `subagent_spawning` hook（角色注入）
- [ ] `before_prompt_build` hook（上下文注入）
- [ ] `before_tool_call` hook（权限门控）

验证标准：
- 手动给 CEO 一条消息 "implement issue #1"
- CEO spawn Dev → Dev 写代码提 PR → CEO spawn QA → QA review 并 merge

### Phase 2：Sprint 循环（1-2 周）

**目标**：PM agent 能自动规划和管理 Sprint

新增：
- [ ] PM 角色 prompt
- [ ] Milestone 工具
- [ ] Sprint scheduler service
- [ ] Heartbeat 配置（定期检查 GitHub 状态）
- [ ] Sprint 状态管理

验证标准：
- PM 创建 Sprint milestone + Issues
- Dev/QA 自动执行
- Sprint 结束自动生成 Retro

### Phase 3：投资人通道（1 周）

**目标**：Feishu 双向通信

新增：
- [ ] Board Report 生成
- [ ] Feishu 消息发送（利用内置 channel）
- [ ] 投资人指令解析（approve/pivot/hire/fire/budget）
- [ ] Budget monitor service

验证标准：
- Sprint 结束自动发 Feishu 报告
- 投资人通过 Feishu 回复 approve → 自动开始下个 Sprint

### Phase 4：元自举（持续）

**目标**：Agent 能改进 VirtuCorp 自身

新增：
- [ ] CONSTITUTION.md 及宪法层保护
- [ ] `type/meta-improvement` Issue 流程
- [ ] Layer 保护 hook（阻止越权修改）
- [ ] Ops agent + Changelog 自动化

验证标准：
- Agent 发现自身流程问题 → 提 meta Issue → 实现修改 → 审批后生效

---

## 附录：与 Spec 的差异

| Spec 中的设计 | 本方案的调整 | 原因 |
|---|---|---|
| Coordinator 作为独立组件 | CEO 就是主 agent session | OpenClaw 的 session 模型天然是 coordinator |
| Agent 互相对话协作 | Agent 通过 GitHub 异步协作 | 避免 token 浪费在 agent 间对话上 |
| 每个 agent 有 CONTEXT.md | Sprint 状态存 `.virtucorp/sprint.json` + GitHub | 减少文件管理负担，GitHub 本身就是上下文 |
| Architect Agent 作为独立角色 | 合并到 PM（规划时）和 QA（审查时） | 减少角色数量，降低初期复杂度 |
| 多模型通过代码切换 | 通过 auth profiles + `before_model_resolve` hook | 利用 OpenClaw 已有能力 |
| Feishu 通知需要额外开发 | 直接用 OpenClaw 内置 Feishu channel | 零开发成本 |

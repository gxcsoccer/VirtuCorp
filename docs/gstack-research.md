# gstack 项目调研报告

> **项目地址**: https://github.com/garrytan/gstack
> **作者**: Garry Tan (Y Combinator CEO)
> **Stars**: ~17.7k | **License**: MIT | **Version**: 0.3.3

---

## 一、项目概述

gstack 将 Claude Code 转化为一支 **专业工程团队**，通过 12 个 slash command 实现不同角色（CEO/PM/Staff Engineer/QA/Release Engineer/Designer/Tech Writer）的认知模式切换。

**核心理念**: "Planning is not review. Review is not shipping." — 让 AI 在不同开发阶段切换到对应的专业角色，比通用 prompt 产出更高质量的结果。

### 核心能力

| Skill | 角色 | 功能 |
|---|---|---|
| `/plan-ceo-review` | 创始人/CEO | 10-star 产品思维，十维度评审 |
| `/plan-eng-review` | 工程经理 | 架构、数据流图、边界 case |
| `/plan-design-review` | 高级设计师 | 80 项设计审计 + AI-slop 检测 |
| `/review` | Staff Engineer | PR review，auto-fix vs ask 分类 |
| `/ship` | 发布工程师 | 端到端发布：merge → test → version bump → changelog → PR |
| `/browse` | QA 工程师 | 持久化无头浏览器，视觉测试 |
| `/qa` | QA + 修复 | 11 阶段测试修复 + 原子提交 + 健康评分 |
| `/retro` | 工程经理 | 数据驱动的回顾，per-person insights |

---

## 二、架构对比

### 2.1 定位差异

| 维度 | gstack | VirtuCorp |
|---|---|---|
| **定位** | Claude Code 增强插件（skill 集合） | AI 原生自治软件公司（OpenClaw 插件） |
| **Agent 模式** | 单 Agent + 角色切换 | 多 Agent 协作（CEO/PM/Dev/QA/Ops） |
| **状态管理** | 文件系统 (.gstack/) | GitHub（Issues/PRs/Labels/Milestones） |
| **自动化程度** | 人触发 slash command | 事件驱动 + 心跳自动调度 |
| **协作方式** | 人机交互（人在 loop 中） | Agent 间自主协作 + 人监督 |

### 2.2 架构图对比

**gstack**: 单 Agent + 认知模式切换
```
Human → Claude Code → /plan → CEO 视角审查
                    → /review → Staff Engineer 视角审查
                    → /qa → QA 视角测试修复
                    → /ship → Release Engineer 视角发布
```

**VirtuCorp**: 多 Agent + 事件驱动
```
Investor → CEO Agent (长生命周期，事件驱动)
              ├─ spawn PM (短生命周期) → 规划
              ├─ spawn Dev (短生命周期) → 编码
              ├─ spawn QA (短生命周期) → 审查
              └─ spawn Ops (短生命周期) → 部署
```

---

## 三、值得借鉴的设计

### 3.1 浏览器守护进程架构 ⭐⭐⭐

gstack 最大的技术亮点。我们的 QA Agent 目前通过 MidsceneJS 做 UI 测试，gstack 提供了一种更高效的方案：

```
CLI binary → HTTP POST → Bun HTTP Server → Playwright → Chromium
(~1ms)        localhost      persistent daemon    headless
```

**优势**:
- **持久化进程**: 浏览器启动一次，后续命令 100-200ms 延迟（vs MCP 方案每次 30s）
- **零 context token 开销**: CLI 输出纯文本到 stdout，不像 MCP 方案每 20 次命令消耗 30k-40k tokens
- **Reference-based 元素选择**: 基于 Accessibility Tree 分配 `@ref`，比 CSS 选择器更稳定
- **环形缓冲区**: O(1) 的 console/network/dialog 日志（50k 条目）

**借鉴点**: 我们可以考虑将 QA 的 UI 测试工具替换为类似的持久化浏览器方案，显著降低延迟和 token 消耗。

### 3.2 WTF-Likelihood 自我调节机制 ⭐⭐⭐

gstack 的 `/qa` 每 5 次修复计算一个风险指标：
- 因素：回滚次数、多文件变更、累计修改量
- **超过 20% → 暂停等人确认**
- **硬上限 50 次修复 → 强制停止**

**借鉴点**: 我们的 circuit breaker 是基于重复状态检测（digest hash 连续 3 次相同）。gstack 的方式是按 **修复质量** 来评估风险，两种方式可以互补：
- 我们的方式防止 "卡住不动"
- gstack 的方式防止 "疯狂修改越改越乱"

**建议**: 在 Dev Agent 中增加累计修改风险评估，当变更文件数/行数超过阈值时自动暂停。

### 3.3 Fix-First Review 模型 ⭐⭐

gstack `/review` 将发现分为两类：
- **AUTO-FIX**: 立即修复（格式、import 顺序等）
- **ASK**: 汇总成一个问题问人

**对比我们**: QA Agent 目前 review 后要么 approve 要么 request-changes，没有自动修复能力。

**建议**: 让 QA Agent 在 review 时对确定性问题（lint、格式、命名）直接提交修复 commit，而非写 comment 等 Dev 改。

### 3.4 AI-Slop 检测 ⭐⭐

`/plan-design-review` 能检测 AI 生成设计的典型特征：
- 紫色渐变
- 统一图标网格
- 通用 stock 图片
- 默认字体

**借鉴点**: 我们可以在 QA review 中加入 "AI-slop" 代码检测：
- 过度注释（每行都注释）
- 冗余错误处理
- 不必要的抽象层
- 模板化的 TODO/FIXME

### 3.5 Documentation as Code ⭐⭐

gstack 的 SKILL.md 从 `.tmpl` 模板生成，CI 通过 dry-run 对比验证文档是否过期。

**借鉴点**: 我们的 role prompt（ceo.md, dev.md 等）目前是手动维护。可以考虑：
- 从代码/配置自动注入动态内容（如可用工具列表、权限矩阵）
- CI 中验证 prompt 与实际能力的一致性

### 3.6 Greptile 集成 + 历史学习 ⭐

gstack 集成了 Greptile（AI PR review 工具），并对其 comment 做分类：
- valid / already-fixed / false-positive
- 历史记录提高信噪比

**借鉴点**: 如果我们引入第三方 review 工具，可以参考这种 triage + 历史学习模式，避免 alert fatigue。

### 3.7 数据驱动的 Retro ⭐

`/retro` 分析 git 历史生成回顾：
- 识别工作 session（45 分钟间隔阈值）
- 跟踪 shipping streaks
- 测试覆盖率比
- per-person 正向反馈

**借鉴点**: 我们的 PM 在 retro 阶段可以增加类似的量化分析，用数据驱动而非凭感觉总结。

---

## 四、不适用 / 已有的方面

| gstack 特性 | 我们的情况 | 结论 |
|---|---|---|
| 单 Agent 角色切换 | 已有多 Agent 架构，更强大 | 不需要 |
| Slash command 触发 | 已有事件驱动自动调度 | 我们更自动化 |
| 文件系统状态管理 | GitHub 作为 single source of truth | 我们方案更可靠 |
| 安全文件保护 | 已有 constitutional guard + permission-guard | 已覆盖 |
| Circuit breaker | 已有 digest hash + 连续失败检测 | 已覆盖（可增强） |
| Knowledge base | 已有 vc_save_knowledge / vc_search_knowledge | 已覆盖 |

---

## 五、行动建议优先级

| 优先级 | 建议 | 预期收益 | 工作量 |
|---|---|---|---|
| **P1** | QA 引入持久化浏览器方案替代 MidsceneJS | UI 测试速度 10x 提升，token 成本大降 | 中 |
| **P1** | Dev Agent 增加累计修改风险评估（WTF-Likelihood） | 防止疯狂修改导致代码质量恶化 | 小 |
| **P2** | QA review 增加 auto-fix 能力 | 减少 review 往返次数 | 小 |
| **P2** | PM retro 增加量化分析 | 更客观的 sprint 评估 | 小 |
| **P3** | QA review 增加 AI-slop 代码检测 | 提高代码质量 | 小 |
| **P3** | Role prompt 模板化 + CI 验证 | 防止 prompt 与实现脱节 | 中 |

---

## 六、总结

gstack 和 VirtuCorp 解决的是同一个问题域（AI 辅助软件开发）的不同层次：

- **gstack** = 增强单人开发效率的 "工具箱"（12 个专业 slash command）
- **VirtuCorp** = 自治的 AI 软件公司（多 Agent 自主协作）

我们在架构层面（多 Agent、事件驱动、GitHub 状态管理、权限体系）已经更加成熟。gstack 的主要借鉴价值在于 **工程实践细节**：持久化浏览器、修复风险自评、auto-fix review、AI-slop 检测等。这些可以作为我们各 Agent 能力的增量增强。

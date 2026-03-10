# VirtuCorp

An AI-native autonomous software company, implemented as an [OpenClaw](https://github.com/openclaw/openclaw) plugin.

VirtuCorp uses a team of specialized AI agents — CEO, PM, Dev, QA, Ops — to autonomously develop software through GitHub-based collaboration. Agents plan sprints, write code, review PRs, and iterate, with a human "investor" providing strategic oversight.

## How It Works

```
Investor (you)
    │  Strategic direction via Feishu / CLI
    ▼
CEO Agent ← heartbeat / webhook / investor commands
    │
    ├─ spawn PM  → plans sprints, creates issues
    ├─ spawn Dev → implements features, creates PRs
    ├─ spawn QA  → reviews code, merges PRs
    └─ spawn Ops → updates docs, changelog
    │
    ▼
GitHub Issues → PRs → CI → Production
```

**Core idea**: GitHub is the nervous system. All state lives in Issues, PRs, Labels, and Milestones — not in agent memory. Agents are stateless functions that read GitHub, do work, and update GitHub.

## First Project: AlphaArena

VirtuCorp's inaugural product is **AlphaArena** — an AI-native simulated stock trading arena where different AI models compete for returns.

- Simulated market engine with real-time order book and price-time priority matching
- Multiple AI trader agents (Claude, Gemini, DeepSeek, Qwen...) each running independent strategies
- Strategy framework: momentum, mean-reversion, sentiment, custom LLM-driven
- Live leaderboard tracking P&L, Sharpe ratio, max drawdown per model
- Backtesting engine for strategy validation before live competition
- The twist: the system VirtuCorp builds is also a test of which AI model trades best

## Quick Start

### 1. Install

```bash
git clone https://github.com/gxcsoccer/VirtuCorp.git
cd VirtuCorp
npm install
```

### 2. Configure

```bash
cp openclawconfig.example.json5 ~/.openclaw/config/openclawconfig.json5
```

Edit the config — fill in your GitHub repo and project path:

```json5
plugins: {
  load: { paths: ["/path/to/VirtuCorp/extensions/virtucorp"] },
  entries: {
    virtucorp: {
      github: { owner: "gxcsoccer", repo: "AlphaArena" },
      projectDir: "/path/to/AlphaArena",
      sprint: { durationDays: 1 },  // daily iterations to start
    }
  }
}
```

### 3. Initialize

Start OpenClaw and run:

```
/vc-init
```

This creates all required GitHub labels, the `.virtucorp/` directory, and Sprint 1.

### 4. Launch

Tell the CEO what to build:

```
Start Sprint 1 for AlphaArena. Here's the spec:

AlphaArena is an AI-native simulated stock trading competition platform.
Different AI models each run trading strategies against a simulated market,
competing on returns, risk-adjusted performance, and consistency.

MVP scope for Sprint 1:
- Simulated order book with price-time priority matching engine
- Portfolio and position tracking per trader
- Strategy interface (buy/sell/hold decisions based on market state)
- One baseline strategy (simple moving average crossover)
- CLI runner to simulate a trading day

Tech stack: TypeScript, Node.js.
```

The CEO will spawn PM to plan, Dev to code, QA to review — autonomously.

## Architecture

```
extensions/virtucorp/
├── index.ts                 Plugin entry point
├── config.ts                Configuration with smart defaults
├── tools/
│   ├── github-prs.ts        Permission-gated: review + merge
│   └── knowledge.ts         Team knowledge base: save / search / list
├── hooks/
│   ├── role-injector.ts     Injects role config on sub-agent spawn
│   ├── model-router.ts      Routes sub-agents to role-specific models
│   ├── context-loader.ts    Injects GitHub state + role prompts
│   ├── permission-guard.ts  Enforces role-based tool access + constitutional guard
│   ├── usage-tracker.ts     Token budget monitoring
│   └── task-router.ts       Cleanup on sub-agent completion
├── services/
│   ├── sprint-scheduler.ts  Autonomous heartbeat loop
│   └── init.ts              One-command project setup
└── roles/
    ├── ceo.md               Event-driven dispatcher
    ├── pm.md                Sprint planning, issue management
    ├── dev.md               Code implementation
    ├── qa.md                Code review, quality gate
    └── ops.md               Documentation, changelog
```

### Design Principles

1. **Event-driven** — agents react to GitHub state changes, not polling loops
2. **GitHub as state machine** — Issues/PRs/Labels are the single source of truth
3. **Agents as functions** — short-lived sub-agents, created per task, destroyed on completion
4. **Permissions as architecture** — tool-level enforcement, not just prompt instructions
5. **Constitutional governance** — layered rules prevent agents from modifying their own constraints
6. **Self-evolution** — agents can improve VirtuCorp itself via `type/meta-improvement` issues, with investor approval required

### Permission Model

| Operation | CEO | PM | Dev | QA | Ops |
|---|---|---|---|---|---|
| Merge PR | ✓ | | | ✓ | |
| Review PR | | | | ✓ | |
| Create Issue | | ✓ | ✓ | ✓ | ✓ |
| Write Code | | | ✓ | | ✓ |
| Plan Sprint | | ✓ | | | |
| Spawn Agents | ✓ | | | | |

Dev agents **cannot** merge PRs — not by prompt instruction, but by tool-level blocking in the `permission-guard` hook. Even `gh pr merge` via shell is intercepted.

## Sprint Lifecycle

```
Planning → Execution → Retrospective → Investor Review → next Sprint
```

Sprint duration is configurable (1–14+ days). Heartbeat frequency auto-scales:

| Sprint | Heartbeat | Use Case |
|---|---|---|
| 1 day | 10 min | Rapid prototyping |
| 3 days | 20 min | Short iterations |
| 1 week | 30 min | Standard dev |
| 2 weeks | 60 min | Established projects |

## Team Knowledge Base

All agents share a persistent knowledge base at `.virtucorp/knowledge/`:

- **decisions/** — Architecture decisions, tech choices
- **patterns/** — Code conventions, discovered patterns
- **research/** — External API evaluations, benchmarks
- **runbook/** — How-to guides, troubleshooting steps

Knowledge is git-tracked and searchable. Agents are instructed to check existing knowledge before starting work and save new findings when done.

## Development

```bash
npm test          # Run 100 unit tests
npm run lint      # ESLint
npm run typecheck # TypeScript check
```

## License

MIT

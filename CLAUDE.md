# VirtuCorp

AI-native autonomous software company, implemented as an OpenClaw plugin.

## First Project: AlphaArena

An AI-native simulated stock trading arena where different AI models compete for returns.
Target repo: `gxcsoccer/AlphaArena`

## Project Structure

```
extensions/virtucorp/     ← The OpenClaw plugin
  index.ts                   Main entry point
  config.ts                  Configuration resolver
  tools/                     Registered agent tools (vc_*)
  hooks/                     Lifecycle hooks (6 hooks)
  services/                  Background services
  roles/                     System prompts per agent role
  lib/                       Shared utilities
docs/
  spec.md                    Original product spec
  design.md                  Technical design document
```

## Architecture

- **CEO Agent**: Main OpenClaw session, event-driven dispatcher
- **Role Sub-agents**: PM, Dev, QA, Ops — spawned via `sessions_spawn` with `vc:<role>` labels
- **GitHub as State Machine**: Issues/PRs/Labels are the source of truth
- **Hooks**: role-injector, model-router, context-loader, permission-guard, usage-tracker, task-router
- **Self-evolution**: agents can improve VirtuCorp via `type/meta-improvement` issues (requires investor approval)

## Development

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

## Key Design Decisions

- Only `vc_review_pr` and `vc_merge_pr` are registered as custom tools (permission gates)
- All other GitHub operations use `gh` CLI directly
- Knowledge base stored in `.virtucorp/knowledge/` (git-tracked)
- Sprint heartbeat auto-scales: 1-day sprint = 10min checks, 14-day = 60min
- Deploy via Vercel CLI (only Ops role can deploy)
- Constitutional guard: permission-guard.ts cannot be modified by any agent

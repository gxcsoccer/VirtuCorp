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

## Prerequisites

VirtuCorp agents depend on the following CLI tools at runtime:

| Tool | Used by | Install |
|------|---------|---------|
| `gh` | All agents | `brew install gh` |
| `opencode` | Dev agent | Build from [source](https://github.com/opencode-ai/opencode): `go build -o ~/bin/opencode .` (requires custom `LOCAL_MODELS` patch, see below) |
| `midscenejs` | QA agent | `npx @anthropic-ai/midscene` |
| `vercel` | Ops agent | `npm i -g vercel` |
| `rg` (ripgrep) | OpenCode dependency | `brew install ripgrep` |

### OpenCode Setup

The Dev agent uses [OpenCode](https://github.com/opencode-ai/opencode) for complex coding tasks. Our fork adds `LOCAL_MODELS` env var support for APIs that don't implement `/v1/models` auto-discovery (e.g. DashScope/bailian).

```bash
# Build from patched source
cd /path/to/opencode
go build -o ~/bin/opencode .

# Required env vars (auto-injected by context-loader for Dev sessions)
LOCAL_ENDPOINT="https://coding.dashscope.aliyuncs.com/v1"
LOCAL_MODELS="glm-5:202752"
```

Project-level config lives in the target repo (e.g. `AlphaArena/.opencode.json`).

## Development

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

## Key Design Decisions

- Only `vc_review_pr`, `vc_merge_pr`, and `vc_ui_accept*` are registered as custom tools (permission gates)
- All other GitHub operations use `gh` CLI directly
- Knowledge base stored in `.virtucorp/knowledge/` (git-tracked)
- UI acceptance tests stored in `.virtucorp/acceptance/` (YAML, git-tracked)
- Sprint heartbeat auto-scales: 1-day sprint = 10min checks, 14-day = 60min
- Sprint lifecycle: planning → executing → retro → review (UI acceptance) → next sprint
- Deploy via Vercel CLI (only Ops role can deploy)
- Constitutional guard: permission-guard.ts cannot be modified by any agent

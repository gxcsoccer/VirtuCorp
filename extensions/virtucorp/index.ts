/**
 * VirtuCorp — OpenClaw Plugin Entry Point
 *
 * An AI-native autonomous software company that operates as a team of
 * specialized agents (PM, Dev, QA, Ops) coordinated by a CEO agent,
 * collaborating through GitHub Issues and PRs.
 *
 * Only permission-gated operations (PR review & merge) are registered as
 * custom tools. Everything else (issue CRUD, PR creation, git ops) is done
 * by agents directly via the `gh` CLI and standard shell tools.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveConfig } from "./config.js";
import { registerContextLoader } from "./hooks/context-loader.js";
import { registerModelRouter } from "./hooks/model-router.js";
import { registerPermissionGuard } from "./hooks/permission-guard.js";
import { registerRoleInjector } from "./hooks/role-injector.js";
import { registerTaskRouter } from "./hooks/task-router.js";
import { registerUsageTracker } from "./hooks/usage-tracker.js";
import { initProject } from "./services/init.js";
import { registerSprintScheduler } from "./services/sprint-scheduler.js";
import { registerPRTools } from "./tools/github-prs.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";

export default {
  id: "virtucorp",
  name: "VirtuCorp",
  description: "AI-native autonomous software company",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    api.logger.info(
      `VirtuCorp: initializing for ${config.github.owner}/${config.github.repo}`,
    );

    // ── Tools ──────────────────────────────────────────────
    registerPRTools(api, config.github);            // gated: review + merge
    registerKnowledgeTools(api, config.projectDir); // shared: save + search + list

    // ── Hooks ──────────────────────────────────────────────
    registerRoleInjector(api);
    registerModelRouter(api, config);
    registerContextLoader(api, config);
    registerPermissionGuard(api);
    registerTaskRouter(api);
    registerUsageTracker(api, config.budget);

    // ── Services ───────────────────────────────────────────
    registerSprintScheduler(api, config);

    // ── CLI Commands ───────────────────────────────────────
    api.registerCommand({
      name: "vc-init",
      description: "Initialize a GitHub repo for VirtuCorp (creates labels, .virtucorp/ dir, Sprint 1)",
      requireAuth: true,
      handler: async () => {
        const log = await initProject(config.github, config.projectDir, config.sprint.durationDays);
        return { text: log.join("\n") };
      },
    });

    api.logger.info("VirtuCorp: plugin registered successfully");
  },
};

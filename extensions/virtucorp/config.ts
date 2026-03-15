/**
 * Configuration resolver.
 *
 * Reads plugin config from OpenClaw and fills in defaults.
 */

import type { VirtuCorpConfig, VirtuCorpRole } from "./lib/types.js";

const DEFAULT_SPRINT = { durationDays: 14, autoRetro: true, heartbeatMinutes: 0 };
const DEFAULT_BUDGET = { dailyLimitUsd: 5, circuitBreakerRetries: 3 };
const DEFAULT_ROLE = { model: undefined };

export function resolveConfig(raw: Record<string, unknown> | undefined): VirtuCorpConfig {
  if (!raw) throw new Error("VirtuCorp: missing plugin config");

  const github = raw.github as VirtuCorpConfig["github"] | undefined;
  if (!github?.owner || !github?.repo) {
    throw new Error("VirtuCorp: github.owner and github.repo are required");
  }

  const projectDir = raw.projectDir as string | undefined;
  if (!projectDir) {
    throw new Error("VirtuCorp: projectDir is required");
  }

  const sprintRaw = (raw.sprint ?? {}) as Partial<VirtuCorpConfig["sprint"]>;
  const budgetRaw = (raw.budget ?? {}) as Partial<VirtuCorpConfig["budget"]>;
  const rolesRaw = (raw.roles ?? {}) as Record<string, Partial<VirtuCorpConfig["roles"][VirtuCorpRole]>>;

  const sprint = { ...DEFAULT_SPRINT, ...sprintRaw };

  // Auto-scale heartbeat based on sprint duration if not explicitly set
  if (!sprintRaw.heartbeatMinutes) {
    if (sprint.durationDays <= 1) {
      sprint.heartbeatMinutes = 10;   // Daily sprint: check every 10 min
    } else if (sprint.durationDays <= 3) {
      sprint.heartbeatMinutes = 20;   // 2-3 day sprint: every 20 min
    } else if (sprint.durationDays <= 7) {
      sprint.heartbeatMinutes = 30;   // Weekly sprint: every 30 min
    } else {
      sprint.heartbeatMinutes = 60;   // Bi-weekly+: every hour
    }
  }

  const productionUrl = raw.productionUrl as string | undefined;

  return {
    github,
    projectDir,
    productionUrl,
    sprint,
    budget: { ...DEFAULT_BUDGET, ...budgetRaw },
    roles: {
      pm: { ...DEFAULT_ROLE, ...rolesRaw.pm },
      dev: { ...DEFAULT_ROLE, ...rolesRaw.dev },
      qa: { ...DEFAULT_ROLE, ...rolesRaw.qa },
      ops: { ...DEFAULT_ROLE, ...rolesRaw.ops },
    },
  };
}

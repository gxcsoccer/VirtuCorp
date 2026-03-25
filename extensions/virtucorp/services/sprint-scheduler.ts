/**
 * Sprint Scheduler Service
 *
 * A background service that drives the VirtuCorp autonomous loop:
 * 1. Periodically checks GitHub state and tells CEO what needs attention
 * 2. Tracks Sprint start/end dates
 * 3. Triggers Sprint retro when the Sprint period expires
 *
 * The scheduler doesn't make decisions — it observes state and produces
 * events that the CEO agent reacts to.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { gh } from "../lib/github-client.js";
import { getActiveSessions, getStaleSessions, clearRoleMetadata, setRoleMetadata, getRoleMetadata } from "../lib/role-metadata.js";
import type { SprintState, VirtuCorpConfig, VirtuCorpRole } from "../lib/types.js";
import { CEO_AGENT_ID, VIRTUCORP_ROLES } from "../lib/types.js";

const SPRINT_STATE_FILE = ".virtucorp/sprint.json";
const DISPATCH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const STALE_SESSION_MAX_MINUTES = 60; // Sessions older than 60 min are likely stale
const SMOKE_TEST_INTERVAL_TICKS = 3; // Run production smoke test every 3rd tick
const SMOKE_TEST_DEDUP_TTL_MS = 2 * 60 * 60 * 1000; // Re-run smoke test after 2h even if state unchanged
const IDLE_WARNING_THRESHOLD = 10; // Warn after this many consecutive no-dispatch ticks

// ── Dispatch throttle state (persisted to survive restarts) ──

type DispatchRecord = {
  digestHash: string;
  timestamp: number;
  consecutiveCount: number; // How many times same action dispatched without state change
};

type SchedulerPersistState = {
  lastDispatch: DispatchRecord | null;
  highWaterMark: number;
  paused?: boolean;
  pauseReason?: string;
};

const SCHEDULER_STATE_FILE = ".virtucorp/scheduler-state.json";

let lastDispatch: DispatchRecord | null = null;
let highWaterMark = 0; // Tracks highest sprint number seen, prevents regression
let tickCount = 0; // Counts ticks for periodic smoke test scheduling
let schedulerStatePath: string | null = null;
let paused = false;
let pauseReason = "";
let consecutiveIdleTicks = 0;

async function loadSchedulerState(projectDir: string): Promise<void> {
  schedulerStatePath = join(projectDir, SCHEDULER_STATE_FILE);
  try {
    const raw = await readFile(schedulerStatePath, "utf-8");
    const state = JSON.parse(raw) as SchedulerPersistState;
    lastDispatch = state.lastDispatch;
    highWaterMark = state.highWaterMark ?? 0;
    paused = state.paused ?? false;
    pauseReason = state.pauseReason ?? "";
  } catch {
    // No saved state — start fresh
  }
}

async function saveSchedulerState(): Promise<void> {
  if (!schedulerStatePath) return;
  try {
    const dir = schedulerStatePath.replace(/\/[^/]+$/, "");
    await mkdir(dir, { recursive: true });
    const state: SchedulerPersistState = { lastDispatch, highWaterMark, paused, pauseReason };
    await writeFile(schedulerStatePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Best-effort
  }
}

/** @internal Reset dispatch throttle state (for testing only) */
export function _resetDispatchState() {
  lastDispatch = null;
  highWaterMark = 0;
  tickCount = 0;
  schedulerStatePath = null;
  paused = false;
  pauseReason = "";
  consecutiveIdleTicks = 0;
}

/** Reset the circuit breaker, allowing dispatch to resume on the next tick. */
export function resetCircuitBreaker(): void {
  lastDispatch = lastDispatch
    ? { ...lastDispatch, consecutiveCount: 0 }
    : null;
  paused = false;
  pauseReason = "";
  void saveSchedulerState();
}

export function computeDigestHash(digest: Digest): string {
  const parts = [
    digest.action,
    ...digest.details.p0Bugs.map(b => `bug:${b.number}`),
    `prs:${digest.details.openPRs}`,
    `ready:${digest.details.readyForDev}`,
    ...digest.details.needsApprovalIssues.map(i => `approval:${i.number}`),
    digest.sprintState?.status ?? "no-sprint",
  ];
  return parts.join("|");
}

export function shouldDispatchToCEO(digest: Digest, last: DispatchRecord | null, now = Date.now()): boolean {
  if (!last) return true;
  const hash = computeDigestHash(digest);
  // State changed (new bugs, different action, etc.) → dispatch immediately
  if (hash !== last.digestHash) return true;
  // Emergency mode: if already stuck (3+ attempts) AND there are P0 bugs,
  // use shorter cooldown (10 min). Non-P0 actions (e.g. spawn_pm_plan from
  // completed status) keep the normal 30-min cooldown to avoid over-escalation.
  if (last.consecutiveCount >= 3 && digest.details.p0Bugs.length > 0) {
    return now - last.timestamp > 10 * 60 * 1000;
  }
  // Same state → respect normal cooldown
  return now - last.timestamp > DISPATCH_COOLDOWN_MS;
}

export function registerSprintScheduler(api: OpenClawPluginApi, config: VirtuCorpConfig) {
  let timer: ReturnType<typeof setInterval> | null = null;

  // Resolve the CEO session key once at init.
  // When the agent has heartbeat.session configured (e.g. bound to a Feishu group),
  // we must enqueue events into that session so the heartbeat runner sees them.
  let ceoSessionKey = `agent:${CEO_AGENT_ID}:main`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = api.runtime.config.loadConfig() as any;
    const hbSession = cfg?.agents?.list
      ?.find((a: { id?: string }) => a.id === CEO_AGENT_ID)
      ?.heartbeat?.session?.trim();
    if (hbSession) {
      ceoSessionKey = `agent:${CEO_AGENT_ID}:${hbSession}`;
    }
  } catch {
    // Fall back to main session if config parsing fails
  }

  api.registerService({
    id: "virtucorp-sprint-scheduler",

    async start(ctx) {
      const intervalMs = config.sprint.heartbeatMinutes * 60 * 1000;
      if (intervalMs <= 0) {
        ctx.logger.info("VirtuCorp scheduler: heartbeat disabled (0 min interval)");
        return;
      }

      // Load persisted state (lastDispatch, highWaterMark) so we survive restarts
      await loadSchedulerState(config.projectDir);

      ctx.logger.info(
        `VirtuCorp scheduler: starting (every ${config.sprint.heartbeatMinutes}min, ` +
        `sprint duration: ${config.sprint.durationDays}d)`,
      );

      // Run once immediately, then on interval
      await tick(api, config, ctx.logger, ceoSessionKey).catch(err =>
        ctx.logger.error(`VirtuCorp scheduler tick error: ${err}`),
      );

      timer = setInterval(async () => {
        await tick(api, config, ctx.logger, ceoSessionKey).catch(err =>
          ctx.logger.error(`VirtuCorp scheduler tick error: ${err}`),
        );
      }, intervalMs);
    },

    async stop(ctx) {
      if (timer) {
        clearInterval(timer);
        timer = null;
        ctx.logger.info("VirtuCorp scheduler: stopped");
      }
    },
  });
}

// ── Tick: the core heartbeat loop ───────────────────────────

async function tick(
  api: OpenClawPluginApi,
  config: VirtuCorpConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  ceoSessionKey: string,
) {
  // ── Discover unknown vc:* sessions so stale cleanup can handle them ──
  // This catches sessions created before persistence was enabled, or leaked sessions.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listFn = (api.runtime.subagent as any).listSessions ?? (api.runtime.subagent as any).list;
    if (typeof listFn === "function") {
      const sessions = await listFn.call(api.runtime.subagent) as Array<{ sessionKey: string; label?: string; createdAt?: number }>;
      for (const session of sessions) {
        const label = session.label;
        if (!label || !label.startsWith("vc:")) continue;
        const role = label.replace("vc:", "") as VirtuCorpRole;
        if (!VIRTUCORP_ROLES.includes(role)) continue;
        if (getRoleMetadata(session.sessionKey)) continue; // Already tracked
        // Register with original createdAt if available, otherwise mark as old enough to be stale
        const createdAt = session.createdAt ?? Date.now() - (STALE_SESSION_MAX_MINUTES + 1) * 60_000;
        setRoleMetadata(session.sessionKey, role);
        logger.info(`VirtuCorp scheduler: discovered untracked session vc:${role}: ${session.sessionKey}`);
      }
    }
  } catch {
    // listSessions not available — rely on metadata-based cleanup only
  }

  // ── Clean up stale sessions that block new spawns ──
  // Clear in-memory metadata AND delete the actual OpenClaw session to free the label.
  const staleSessions = getStaleSessions(STALE_SESSION_MAX_MINUTES);
  for (const stale of staleSessions) {
    logger.warn(
      `VirtuCorp scheduler: clearing stale ${stale.role} session (${stale.ageMinutes}min old): ${stale.sessionKey}`,
    );
    clearRoleMetadata(stale.sessionKey);
    try {
      await api.runtime.subagent.deleteSession({ sessionKey: stale.sessionKey });
      logger.info(`VirtuCorp scheduler: deleted stale session ${stale.sessionKey} to free vc:${stale.role} label`);
    } catch (err) {
      logger.warn(`VirtuCorp scheduler: failed to delete stale session ${stale.sessionKey}: ${err}`);
    }
  }

  const state = await loadSprintState(config.projectDir);
  const summary = await collectGitHubSummary(config);

  // Guard against sprint regression (e.g. PM accidentally overwrites with lower number)
  if (state && highWaterMark > 0 && state.current < highWaterMark) {
    logger.warn(
      `VirtuCorp scheduler: sprint.json regressed from ${highWaterMark} to ${state.current}! Restoring.`,
    );
    state.current = highWaterMark;
    await saveSprintState(config.projectDir, state);
  }
  if (state && state.current > highWaterMark) {
    highWaterMark = state.current;
    void saveSchedulerState();
  }

  // Check if Sprint has expired
  if (state && isSprintExpired(state)) {
    if (state.status === "executing") {
      logger.info("VirtuCorp scheduler: Sprint expired, triggering retro");
      state.status = "retro";
      await saveSprintState(config.projectDir, state);
    }
  }

  tickCount++;

  // Build a status digest for the CEO to act on.
  // First try without smoke test to see if there's higher-priority work.
  // If nothing actionable and productionUrl is configured, run smoke test —
  // but only every SMOKE_TEST_INTERVAL_TICKS ticks, and skip if the last
  // dispatch was already a smoke test with the same state (i.e. it passed).
  let digest = buildDigest(state, summary);
  if (!digest && config.productionUrl) {
    if (tickCount % SMOKE_TEST_INTERVAL_TICKS === 0) {
      const candidate = buildDigest(state, summary, { productionUrl: config.productionUrl });
      if (candidate) {
        // Skip re-dispatch if this exact smoke test was recently dispatched (test passed, state unchanged).
        // But expire the dedup after SMOKE_TEST_DEDUP_TTL_MS — production can regress without state change.
        const candidateHash = computeDigestHash(candidate);
        if (lastDispatch && lastDispatch.digestHash === candidateHash
            && (Date.now() - lastDispatch.timestamp) < SMOKE_TEST_DEDUP_TTL_MS) {
          logger.info("VirtuCorp scheduler: smoke test already dispatched and state unchanged, skipping");
        } else {
          digest = candidate;
        }
      }
    }
  }
  if (!digest) {
    consecutiveIdleTicks++;
    if (consecutiveIdleTicks >= IDLE_WARNING_THRESHOLD) {
      logger.warn(
        `VirtuCorp scheduler: ${consecutiveIdleTicks} consecutive idle ticks with no dispatch — ` +
        `system may be stuck in a silent state`,
      );
    }
    return;
  }
  consecutiveIdleTicks = 0;

  logger.info(`VirtuCorp scheduler: ${digest.reason}`);

  // ── Pause check: auto-resume if state changed OR cooldown expired ──
  const currentHash = computeDigestHash(digest);
  if (paused) {
    const pausedDuration = lastDispatch ? Date.now() - lastDispatch.timestamp : 0;
    if (lastDispatch && currentHash !== lastDispatch.digestHash) {
      logger.info(`VirtuCorp scheduler: state changed while paused, auto-resuming`);
      paused = false;
      pauseReason = "";
      lastDispatch = { ...lastDispatch, consecutiveCount: 0 };
      void saveSchedulerState();
    } else if (pausedDuration > 30 * 60 * 1000) {
      // Auto-resume after 30 min — permanent pause is worse than retrying
      logger.info(`VirtuCorp scheduler: paused for ${Math.round(pausedDuration / 60000)}min, auto-resuming`);
      paused = false;
      pauseReason = "";
      lastDispatch = lastDispatch ? { ...lastDispatch, consecutiveCount: 0 } : null;
      void saveSchedulerState();
    } else {
      logger.info(`VirtuCorp scheduler: paused (${pauseReason}), skipping dispatch`);
      return;
    }
  }

  // ── Proactive session cleanup before dispatch ──
  // Before asking CEO to spawn a role, delete any tracked session for that role.
  // This prevents "label already in use" errors for known zombie sessions.
  const targetRole = extractTargetRole(digest.action);
  if (targetRole) {
    const activeSessions = getActiveSessions();
    const existing = activeSessions.get(targetRole);
    if (existing) {
      logger.warn(
        `VirtuCorp scheduler: proactive cleanup of vc:${targetRole} (${existing.sessionKey}, ${existing.ageMinutes}min old)`,
      );
      clearRoleMetadata(existing.sessionKey);
      try {
        await api.runtime.subagent.deleteSession({ sessionKey: existing.sessionKey });
      } catch {
        // Session may already be gone
      }
    }
  }

  // Dispatch to CEO agent if state warrants it and we haven't recently dispatched the same thing
  if (shouldDispatchToCEO(digest, lastDispatch)) {
    // Build session status info so CEO knows which roles are busy or stale
    const activeSessions = getActiveSessions();
    const sessionLines: string[] = [];
    for (const [role, info] of activeSessions) {
      sessionLines.push(`  - vc:${role}: active for ${info.ageMinutes}min`);
    }

    const staleLines: string[] = [];
    for (const stale of staleSessions) {
      staleLines.push(`  - vc:${stale.role} (${stale.ageMinutes}min old) — run \`sessions_delete\` on this before spawning`);
    }

    let sessionInfo: string;
    if (staleLines.length > 0) {
      sessionInfo = `\n\n⚠️ Stale sessions detected (cleaned from scheduler, but you MUST delete them in OpenClaw before spawning):\n${staleLines.join("\n")}`;
    } else if (sessionLines.length > 0) {
      sessionInfo = `\n\nActive sub-agent sessions:\n${sessionLines.join("\n")}`;
    } else {
      sessionInfo = "\n\nNo active sub-agent sessions (all roles available to spawn).";
    }

    try {
      const consecutive = lastDispatch && lastDispatch.digestHash === currentHash
        ? lastDispatch.consecutiveCount + 1
        : 1;

      const retries = config.budget.circuitBreakerRetries; // default: 3

      // ── Tiered escalation based on consecutive dispatch count ──
      if (consecutive >= retries * 3 + 1) {
        // Tier 3: give up — delete CEO session, send escalation, pause
        const actionDetail = digest.details.p0Bugs.length > 0
          ? `P0 bug: ${digest.details.p0Bugs.map(b => `#${b.number}: ${b.title}`).join(", ")}`
          : digest.reason;

        logger.warn(
          `VirtuCorp scheduler: circuit breaker OPEN — pausing after ${consecutive} consecutive failures on ${digest.action}`,
        );

        // Delete CEO session to start fresh (critical: without this, escalation can't be delivered)
        try {
          await api.runtime.subagent.deleteSession({ sessionKey: ceoSessionKey });
        } catch {
          // Session may already be gone
        }

        // Send escalation to fresh CEO session → will be output to Feishu group via heartbeat
        const issueLinks = digest.details.p0Bugs.map(b => `#${b.number}`).join(", ");
        api.runtime.system.enqueueSystemEvent(
          `[VirtuCorp Scheduler]\n\n🚨 VirtuCorp 需要 Investor 介入\n\n` +
          `卡住的任务：${actionDetail}\n` +
          `连续尝试：${consecutive} 次，团队无法自行解决\n` +
          (issueLinks ? `相关 Issue：${issueLinks}\n\n` : `\n`) +
          `你可以：\n` +
          `1. 在群里给 CEO 新指令（换思路、回滚等）\n` +
          `2. 手动修复后 push，状态变化后自动恢复调度\n` +
          `3. 降低优先级：gh issue edit #N --remove-label priority/p0\n` +
          `4. /vc-reset 重置断路器，让团队再试一轮`,
          { sessionKey: ceoSessionKey },
        );
        api.runtime.system.requestHeartbeatNow({
          reason: "wake",
          agentId: CEO_AGENT_ID,
        });

        paused = true;
        pauseReason = `circuit breaker: ${consecutive} consecutive failures on ${digest.action}`;
        lastDispatch = {
          digestHash: currentHash,
          timestamp: Date.now(),
          consecutiveCount: consecutive,
        };
        void saveSchedulerState();
        logger.info(`VirtuCorp scheduler: escalation sent, scheduler paused`);
        return;
      }

      if (consecutive >= retries * 2) {
        // Tier 2: force-delete CEO session to clear corrupted context, then dispatch
        logger.warn(
          `VirtuCorp scheduler: force-resetting CEO session (${consecutive} consecutive dispatches on ${digest.action})`,
        );
        try {
          await api.runtime.subagent.deleteSession({ sessionKey: ceoSessionKey });
        } catch {
          // Session may already be gone
        }
      } else if (consecutive >= retries) {
        // Tier 1: clean stale sessions + request session reset
        logger.warn(
          `VirtuCorp scheduler: CEO stuck on ${digest.action} (${consecutive} consecutive dispatches). Cleaning stale sessions.`,
        );

        const active = getActiveSessions();
        for (const [role, info] of active) {
          logger.warn(`VirtuCorp scheduler: force-deleting vc:${role} session ${info.sessionKey} (${info.ageMinutes}min old)`);
          clearRoleMetadata(info.sessionKey);
          try {
            await api.runtime.subagent.deleteSession({ sessionKey: info.sessionKey });
          } catch {
            // Session may already be gone
          }
        }

        try {
          await api.runtime.system.requestSessionReset({
            agentId: CEO_AGENT_ID,
          });
        } catch {
          // requestSessionReset may not exist
        }
      }

      // Enqueue event text so it's prepended to CEO's next prompt
      const urgencyPrefix = consecutive >= retries
        ? "⚠️ URGENT: This action has been dispatched multiple times but not executed. You MUST act on it NOW.\n\n"
        : "";
      api.runtime.system.enqueueSystemEvent(
        `[VirtuCorp Scheduler] ${urgencyPrefix}${digest.reason}${sessionInfo}`,
        { sessionKey: ceoSessionKey },
      );
      // Wake the CEO agent to process the event
      api.runtime.system.requestHeartbeatNow({
        reason: "wake",
        agentId: CEO_AGENT_ID,
      });

      lastDispatch = {
        digestHash: currentHash,
        timestamp: Date.now(),
        consecutiveCount: consecutive,
      };
      void saveSchedulerState();
      logger.info(`VirtuCorp scheduler: dispatched to CEO (action=${digest.action}, attempt=${consecutive})`);
    } catch (err) {
      logger.warn(`VirtuCorp scheduler: failed to dispatch to CEO: ${err}`);
    }
  }
}

// ── Sprint State Persistence ────────────────────────────────

export async function loadSprintState(projectDir: string): Promise<SprintState | null> {
  try {
    const raw = await readFile(join(projectDir, SPRINT_STATE_FILE), "utf-8");
    const data = JSON.parse(raw);
    return normalizeSprintState(data);
  } catch {
    return null;
  }
}

/**
 * Normalize sprint.json into the canonical SprintState shape.
 *
 * PM agents write a nested format: `{ sprint: { number, status, period: { start, end }, milestone } }`.
 * The scheduler expects the flat format: `{ current, status, startDate, endDate, milestone }`.
 * This function accepts both and returns the flat format, or null if unrecognizable.
 */
export function normalizeSprintState(data: unknown): SprintState | null {
  if (!data || typeof data !== "object") return null;

  const record = data as Record<string, unknown>;

  // Flat format (canonical): { current, status, startDate, endDate }
  if (typeof record.current === "number" && typeof record.status === "string") {
    return data as SprintState;
  }

  // Nested format (PM-written): { sprint: { number, status, period: { start, end } } }
  const sprint = record.sprint as Record<string, unknown> | undefined;
  if (!sprint || typeof sprint !== "object") return null;

  const number = sprint.number;
  const status = sprint.status;
  const period = sprint.period as Record<string, unknown> | undefined;
  const milestone = sprint.milestone;

  if (typeof number !== "number" || typeof status !== "string") return null;

  const validStatuses = ["planning", "executing", "retro", "review", "completed"];
  if (!validStatuses.includes(status)) return null;

  return {
    current: number,
    startDate: period && typeof period.start === "string" ? period.start : "",
    endDate: period && typeof period.end === "string" ? period.end : "",
    milestone: typeof milestone === "number" ? milestone : null,
    status: status as SprintState["status"],
  };
}

export async function saveSprintState(projectDir: string, state: SprintState): Promise<void> {
  const dir = join(projectDir, ".virtucorp");
  await mkdir(dir, { recursive: true });
  await writeFile(join(projectDir, SPRINT_STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

export function createInitialSprintState(sprintNumber: number, durationDays: number): SprintState {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + durationDays);

  return {
    current: sprintNumber,
    startDate: now.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
    milestone: null,
    status: "planning",
  };
}

export function isSprintExpired(state: SprintState): boolean {
  const now = new Date();
  const end = new Date(state.endDate + "T23:59:59");
  return now > end;
}

// ── GitHub State Collector ──────────────────────────────────

export type GitHubSummary = {
  readyForDev: number;
  inProgress: number;
  inReview: number;
  openPRs: number;
  untriaged: Array<{ number: number; title: string }>;
  p0Bugs: Array<{ number: number; title: string }>;
  needsApprovalPRs: Array<{ number: number; title: string }>;
  needsApprovalIssues: Array<{ number: number; title: string }>;
};

async function collectGitHubSummary(config: VirtuCorpConfig): Promise<GitHubSummary> {
  try {
    const [issuesRaw, prsRaw] = await Promise.all([
      gh(["issue", "list", "--json", "number,title,labels", "--limit", "100", "--state", "open"], config.github),
      gh(["pr", "list", "--json", "number,title,labels", "--limit", "100", "--state", "open"], config.github),
    ]);

    const issues = issuesRaw ? JSON.parse(issuesRaw) as Array<{ number: number; title: string; labels: Array<{ name: string }> }> : [];
    const prs = prsRaw ? JSON.parse(prsRaw) as Array<{ number: number; title: string; labels: Array<{ name: string }> }> : [];

    let readyForDev = 0;
    let inProgress = 0;
    let inReview = 0;

    const p0Bugs: Array<{ number: number; title: string }> = [];
    const untriaged: Array<{ number: number; title: string }> = [];

    for (const issue of issues) {
      const labelNames = issue.labels.map(l => l.name);
      const hasStatusLabel = labelNames.some(l => l.startsWith("status/"));
      if (labelNames.includes("status/ready-for-dev")) readyForDev++;
      if (labelNames.includes("status/in-progress")) inProgress++;
      if (labelNames.includes("status/in-review")) inReview++;
      // Track P0 bugs separately — these need urgent attention
      if (labelNames.includes("priority/p0") && labelNames.includes("type/bug")) {
        p0Bugs.push({ number: issue.number, title: issue.title });
      }
      // Issues with no status/* label need PM triage
      if (!hasStatusLabel && !labelNames.includes("needs-investor-approval")) {
        untriaged.push({ number: issue.number, title: issue.title });
      }
    }

    const needsApprovalPRs = prs
      .filter(pr => pr.labels.some(l => l.name === "needs-investor-approval"))
      .map(pr => ({ number: pr.number, title: pr.title }));

    const needsApprovalIssues = issues
      .filter(issue => issue.labels.some(l => l.name === "needs-investor-approval"))
      .map(issue => ({ number: issue.number, title: issue.title }));

    return { readyForDev, inProgress, inReview, openPRs: prs.length, untriaged, p0Bugs, needsApprovalPRs, needsApprovalIssues };
  } catch {
    return { readyForDev: 0, inProgress: 0, inReview: 0, openPRs: 0, untriaged: [], p0Bugs: [], needsApprovalPRs: [], needsApprovalIssues: [] };
  }
}

// ── Digest Builder ──────────────────────────────────────────

type Digest = {
  reason: string;
  action: "spawn_dev" | "spawn_dev_bugfix" | "spawn_qa" | "spawn_qa_acceptance" | "spawn_qa_smoke" | "spawn_pm_retro" | "spawn_pm_plan" | "notify_investor_approval" | "idle";
  details: GitHubSummary;
  sprintState: SprintState | null;
};

export type DigestOptions = {
  productionUrl?: string;
};

/** Map digest action to the VirtuCorp role that will be spawned. */
function extractTargetRole(action: string): VirtuCorpRole | null {
  if (action.startsWith("spawn_dev")) return "dev";
  if (action.startsWith("spawn_qa")) return "qa";
  if (action.startsWith("spawn_pm")) return "pm";
  if (action.startsWith("spawn_ops")) return "ops";
  return null;
}

export function buildDigest(state: SprintState | null, summary: GitHubSummary, options: DigestOptions = {}): Digest | null {
  // No sprint yet — needs initialization
  if (!state) {
    return {
      reason: "No sprint state found. CEO should initialize Sprint 1.",
      action: "spawn_pm_plan",
      details: summary,
      sprintState: null,
    };
  }

  // Sprint retro needed
  if (state.status === "retro") {
    return {
      reason: `Sprint ${state.current} ended. Retro needed.`,
      action: "spawn_pm_retro",
      details: summary,
      sprintState: state,
    };
  }

  // UI acceptance review needed after retro
  if (state.status === "review") {
    return {
      reason: `Sprint ${state.current} retro complete. UI acceptance review needed.`,
      action: "spawn_qa_acceptance",
      details: summary,
      sprintState: state,
    };
  }

  // Sprint completed — transition to next Sprint planning
  // But if there are still P0 bugs, fix them first before planning next Sprint
  if (state.status === "completed") {
    if (summary.p0Bugs.length > 0) {
      const bugList = summary.p0Bugs.map(b => `#${b.number}: ${b.title}`).join(", ");
      return {
        reason: `🚨 Sprint ${state.current} completed but ${summary.p0Bugs.length} P0 bug(s) still open: ${bugList}. Fix before planning next Sprint.`,
        action: "spawn_dev_bugfix",
        details: summary,
        sprintState: state,
      };
    }
    return {
      reason: `Sprint ${state.current} completed. Ready to plan Sprint ${state.current + 1}.`,
      action: "spawn_pm_plan",
      details: summary,
      sprintState: state,
    };
  }

  // Sprint in planning but no issues created yet — PM needs to plan
  if (state.status === "planning" && summary.readyForDev === 0 && summary.inProgress === 0 && summary.openPRs === 0) {
    return {
      reason: `Sprint ${state.current} is in planning but has no issues. Spawn PM to plan.`,
      action: "spawn_pm_plan",
      details: summary,
      sprintState: state,
    };
  }

  // ── P0 bugs take absolute priority over everything else during execution ──
  if (summary.p0Bugs.length > 0) {
    const bugList = summary.p0Bugs.map(b => `#${b.number}: ${b.title}`).join(", ");
    return {
      reason: `🚨 ${summary.p0Bugs.length} P0 bug(s) need urgent fix: ${bugList}`,
      action: "spawn_dev_bugfix",
      details: summary,
      sprintState: state,
    };
  }

  // Normal execution — route based on GitHub state
  if (summary.openPRs > 0) {
    return {
      reason: `${summary.openPRs} open PRs need review`,
      action: "spawn_qa",
      details: summary,
      sprintState: state,
    };
  }

  if (summary.readyForDev > 0) {
    return {
      reason: `${summary.readyForDev} issues ready for dev`,
      action: "spawn_dev",
      details: summary,
      sprintState: state,
    };
  }

  // Issues waiting for investor approval (meta-improvement)
  if (summary.needsApprovalIssues.length > 0) {
    const issueList = summary.needsApprovalIssues.map(i => `#${i.number}: ${i.title}`).join(", ");
    return {
      reason: `${summary.needsApprovalIssues.length} meta-improvement issue(s) awaiting investor approval: ${issueList}`,
      action: "notify_investor_approval",
      details: summary,
      sprintState: state,
    };
  }

  // Periodic production smoke test — only when nothing else is actionable
  if (options.productionUrl) {
    return {
      reason: `Production smoke test due. Run UI tests against ${options.productionUrl}`,
      action: "spawn_qa_smoke",
      details: summary,
      sprintState: state,
    };
  }

  // Open issues without status labels need PM triage
  if (summary.untriaged.length > 0) {
    const issueList = summary.untriaged.map(i => `#${i.number}: ${i.title}`).join(", ");
    return {
      reason: `${summary.untriaged.length} untriaged issue(s) need PM to add status labels: ${issueList}`,
      action: "spawn_pm_plan",
      details: summary,
      sprintState: state,
    };
  }

  // Nothing to do
  return null;
}

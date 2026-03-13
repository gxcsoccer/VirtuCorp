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
import { getActiveSessions, getStaleSessions, clearRoleMetadata } from "../lib/role-metadata.js";
import type { SprintState, VirtuCorpConfig } from "../lib/types.js";

const SPRINT_STATE_FILE = ".virtucorp/sprint.json";
const CEO_AGENT_ID = "virtucorp-ceo";
const DISPATCH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const STALE_SESSION_MAX_MINUTES = 60; // Sessions older than 60 min are likely stale

// ── Dispatch throttle state (in-memory, resets on restart = immediate first dispatch) ──

type DispatchRecord = {
  digestHash: string;
  timestamp: number;
};

let lastDispatch: DispatchRecord | null = null;

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
  // Same state → respect cooldown
  return now - last.timestamp > DISPATCH_COOLDOWN_MS;
}

export function registerSprintScheduler(api: OpenClawPluginApi, config: VirtuCorpConfig) {
  let timer: ReturnType<typeof setInterval> | null = null;

  api.registerService({
    id: "virtucorp-sprint-scheduler",

    async start(ctx) {
      const intervalMs = config.sprint.heartbeatMinutes * 60 * 1000;
      if (intervalMs <= 0) {
        ctx.logger.info("VirtuCorp scheduler: heartbeat disabled (0 min interval)");
        return;
      }

      ctx.logger.info(
        `VirtuCorp scheduler: starting (every ${config.sprint.heartbeatMinutes}min, ` +
        `sprint duration: ${config.sprint.durationDays}d)`,
      );

      // Run once immediately, then on interval
      await tick(api, config, ctx.logger).catch(err =>
        ctx.logger.error(`VirtuCorp scheduler tick error: ${err}`),
      );

      timer = setInterval(async () => {
        await tick(api, config, ctx.logger).catch(err =>
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
) {
  // ── Clean up stale sessions that block new spawns ──
  // We can only clear our in-memory metadata here (background service can't call subagent APIs).
  // The CEO prompt instructs it to `sessions_delete` the actual OpenClaw session if spawn fails.
  const staleSessions = getStaleSessions(STALE_SESSION_MAX_MINUTES);
  for (const stale of staleSessions) {
    logger.warn(
      `VirtuCorp scheduler: clearing stale ${stale.role} metadata (${stale.ageMinutes}min old): ${stale.sessionKey}`,
    );
    clearRoleMetadata(stale.sessionKey);
  }

  const state = await loadSprintState(config.projectDir);
  const summary = await collectGitHubSummary(config);

  // Check if Sprint has expired
  if (state && isSprintExpired(state)) {
    if (state.status === "executing") {
      logger.info("VirtuCorp scheduler: Sprint expired, triggering retro");
      state.status = "retro";
      await saveSprintState(config.projectDir, state);
    }
  }

  // Build a status digest for the CEO to act on
  const digest = buildDigest(state, summary);
  if (!digest) return;

  logger.info(`VirtuCorp scheduler: ${digest.reason}`);

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
      // Enqueue event text so it's prepended to CEO's next prompt
      api.runtime.system.enqueueSystemEvent(
        `[VirtuCorp Scheduler] ${digest.reason}${sessionInfo}`,
        { sessionKey: `agent:${CEO_AGENT_ID}:main` },
      );
      // Wake the CEO agent to process the event
      api.runtime.system.requestHeartbeatNow({
        reason: "wake",
        agentId: CEO_AGENT_ID,
      });

      lastDispatch = {
        digestHash: computeDigestHash(digest),
        timestamp: Date.now(),
      };
      logger.info(`VirtuCorp scheduler: dispatched to CEO (action=${digest.action})`);
    } catch (err) {
      logger.warn(`VirtuCorp scheduler: failed to dispatch to CEO: ${err}`);
    }
  }
}

// ── Sprint State Persistence ────────────────────────────────

export async function loadSprintState(projectDir: string): Promise<SprintState | null> {
  try {
    const raw = await readFile(join(projectDir, SPRINT_STATE_FILE), "utf-8");
    return JSON.parse(raw) as SprintState;
  } catch {
    return null;
  }
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

    for (const issue of issues) {
      const labelNames = issue.labels.map(l => l.name);
      if (labelNames.includes("status/ready-for-dev")) readyForDev++;
      if (labelNames.includes("status/in-progress")) inProgress++;
      if (labelNames.includes("status/in-review")) inReview++;
      // Track P0 bugs separately — these need urgent attention
      if (labelNames.includes("priority/p0") && labelNames.includes("type/bug")) {
        p0Bugs.push({ number: issue.number, title: issue.title });
      }
    }

    const needsApprovalPRs = prs
      .filter(pr => pr.labels.some(l => l.name === "needs-investor-approval"))
      .map(pr => ({ number: pr.number, title: pr.title }));

    const needsApprovalIssues = issues
      .filter(issue => issue.labels.some(l => l.name === "needs-investor-approval"))
      .map(issue => ({ number: issue.number, title: issue.title }));

    return { readyForDev, inProgress, inReview, openPRs: prs.length, p0Bugs, needsApprovalPRs, needsApprovalIssues };
  } catch {
    return { readyForDev: 0, inProgress: 0, inReview: 0, openPRs: 0, p0Bugs: [], needsApprovalPRs: [], needsApprovalIssues: [] };
  }
}

// ── Digest Builder ──────────────────────────────────────────

type Digest = {
  reason: string;
  action: "spawn_dev" | "spawn_dev_bugfix" | "spawn_qa" | "spawn_qa_acceptance" | "spawn_pm_retro" | "spawn_pm_plan" | "notify_investor_approval" | "idle";
  details: GitHubSummary;
  sprintState: SprintState | null;
};

export function buildDigest(state: SprintState | null, summary: GitHubSummary): Digest | null {
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

  // Nothing to do
  return null;
}

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
import type { SprintState, VirtuCorpConfig } from "../lib/types.js";

const SPRINT_STATE_FILE = ".virtucorp/sprint.json";

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
  if (digest) {
    logger.info(`VirtuCorp scheduler: ${digest.reason}`);
    // The digest is sent to the CEO via runtime messaging
    // For now, we log it — actual delivery depends on the gateway session wiring
    // which will be connected when we integrate with the CEO agent's session
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

type GitHubSummary = {
  readyForDev: number;
  inProgress: number;
  inReview: number;
  openPRs: number;
};

async function collectGitHubSummary(config: VirtuCorpConfig): Promise<GitHubSummary> {
  try {
    const [issuesRaw, prsRaw] = await Promise.all([
      gh(["issue", "list", "--json", "labels", "--limit", "100", "--state", "open"], config.github),
      gh(["pr", "list", "--json", "number", "--limit", "100", "--state", "open"], config.github),
    ]);

    const issues = issuesRaw ? JSON.parse(issuesRaw) as Array<{ labels: Array<{ name: string }> }> : [];
    const prs = prsRaw ? JSON.parse(prsRaw) as Array<{ number: number }> : [];

    let readyForDev = 0;
    let inProgress = 0;
    let inReview = 0;

    for (const issue of issues) {
      const labelNames = issue.labels.map(l => l.name);
      if (labelNames.includes("status/ready-for-dev")) readyForDev++;
      if (labelNames.includes("status/in-progress")) inProgress++;
      if (labelNames.includes("status/in-review")) inReview++;
    }

    return { readyForDev, inProgress, inReview, openPRs: prs.length };
  } catch {
    return { readyForDev: 0, inProgress: 0, inReview: 0, openPRs: 0 };
  }
}

// ── Digest Builder ──────────────────────────────────────────

type Digest = {
  reason: string;
  action: "spawn_dev" | "spawn_qa" | "spawn_qa_acceptance" | "spawn_pm_retro" | "spawn_pm_plan" | "idle";
  details: GitHubSummary;
  sprintState: SprintState | null;
};

function buildDigest(state: SprintState | null, summary: GitHubSummary): Digest | null {
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

  // Nothing to do
  return null;
}

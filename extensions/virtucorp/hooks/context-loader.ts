/**
 * before_prompt_build hook: inject context for both CEO and role sub-agents.
 *
 * - CEO session (no role metadata): gets CEO prompt + live GitHub state digest
 * - Role sub-agent: gets role-specific prompt + project context
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { gh } from "../lib/github-client.js";
import { getRoleMetadata } from "../lib/role-metadata.js";
import { loadSprintState } from "../services/sprint-scheduler.js";
import { CEO_AGENT_ID } from "../lib/types.js";
import type { VirtuCorpConfig } from "../lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLES_DIR = join(__dirname, "..", "roles");

const promptCache = new Map<string, string>();

async function loadRolePrompt(role: string): Promise<string> {
  const cached = promptCache.get(role);
  if (cached) return cached;

  const filePath = join(ROLES_DIR, `${role}.md`);
  const content = await readFile(filePath, "utf-8");
  promptCache.set(role, content);
  return content;
}

// ── Static project context (for sub-agents) ─────────────────

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  pm: "VirtuCorp PM",
  dev: "VirtuCorp Dev",
  qa: "VirtuCorp QA",
  ops: "VirtuCorp Ops",
};

const ROLE_EMAILS: Record<string, string> = {
  pm: "vc-pm@virtucorp.ai",
  dev: "vc-dev@virtucorp.ai",
  qa: "vc-qa@virtucorp.ai",
  ops: "vc-ops@virtucorp.ai",
};

function buildProjectContext(config: VirtuCorpConfig, role?: string): string {
  const lines = [
    `## VirtuCorp Project Context`,
    `- **Repository**: ${config.github.owner}/${config.github.repo}`,
    `- **Project Directory**: ${config.projectDir}`,
    `- **Sprint Duration**: ${config.sprint.durationDays} days`,
  ];

  // Inject role identity so agents sign their work
  if (role) {
    const displayName = ROLE_DISPLAY_NAMES[role] ?? `VirtuCorp ${role}`;
    const email = ROLE_EMAILS[role] ?? `vc-${role}@virtucorp.ai`;
    lines.push(
      ``,
      `## Your Identity`,
      `- **Role**: ${role} (label: vc:${role})`,
      `- **Git Author**: ${displayName} <${email}>`,
      `- **Signature**: — vc:${role}`,
      `- All your GitHub actions (commits, comments, reviews) must be signed with your role identity.`,
    );
  }

  // Inject OpenCode environment for Dev agent
  if (role === "dev") {
    lines.push(
      ``,
      `## OpenCode Environment`,
      `When using OpenCode, set these environment variables:`,
      "```bash",
      `export LOCAL_ENDPOINT="https://coding.dashscope.aliyuncs.com/v1"`,
      `export LOCAL_MODELS="glm-5:202752"`,
      `opencode -p "<task description>" -q -c ${config.projectDir}`,
      "```",
    );
  }

  lines.push(
    ``,
    `## Label Conventions`,
    `- Status: status/ready-for-dev, status/in-progress, status/in-review, status/done`,
    `- Priority: priority/p0 (critical), priority/p1 (high), priority/p2 (normal)`,
    `- Type: type/feature, type/bug, type/refactor, type/chore`,
    ``,
    `## Workflow`,
    `1. Issues with "status/ready-for-dev" are ready to be worked on`,
    `2. When starting work, change label to "status/in-progress"`,
    `3. After creating PR, change to "status/in-review"`,
    `4. After merge, change to "status/done"`,
  );

  return lines.join("\n");
}

// ── Live GitHub state digest (for CEO) ──────────────────────

export async function buildCEODigest(config: VirtuCorpConfig): Promise<string> {
  const lines: string[] = [`## Current Situation`];

  // Sprint state
  const sprint = await loadSprintState(config.projectDir);
  if (sprint) {
    lines.push(`\n### Sprint ${sprint.current} (${sprint.status})`);
    lines.push(`- Period: ${sprint.startDate} → ${sprint.endDate}`);
    if (sprint.milestone) lines.push(`- Milestone: #${sprint.milestone}`);
  } else {
    lines.push(`\n### ⚠ No Sprint initialized`);
    lines.push(`Run /vc-init or tell PM to plan Sprint 1.`);
  }

  // Live GitHub state
  try {
    const summary = await collectGitHubState(config);
    lines.push(`\n### GitHub State`);
    lines.push(`- Issues ready for dev: ${summary.readyForDev}`);
    lines.push(`- Issues in progress: ${summary.inProgress}`);
    lines.push(`- PRs awaiting review: ${summary.prsAwaitingReview}`);
    lines.push(`- PRs approved (ready to merge): ${summary.prsApproved}`);
    lines.push(`- Total open issues: ${summary.totalOpen}`);
    if (summary.p0Bugs.length > 0) {
      lines.push(`- 🚨 **P0 Bugs**: ${summary.p0Bugs.length}`);
      for (const bug of summary.p0Bugs) {
        lines.push(`  - #${bug.number}: ${bug.title}`);
      }
    }

    if (summary.failedDeployPRs.length > 0) {
      lines.push(`- 🔴 **Deploy failures**: ${summary.failedDeployPRs.length}`);
      for (const pr of summary.failedDeployPRs) {
        lines.push(`  - PR #${pr.number}: ${pr.title}`);
      }
    }

    // P0 bugs take highest priority — must be fixed before any new feature work
    if (summary.p0Bugs.length > 0) {
      lines.push(`\n🚨 **URGENT**: ${summary.p0Bugs.length} P0 bug(s) open. Spawn Dev to fix these BEFORE any feature work.`);
    } else if (summary.failedDeployPRs.length > 0) {
      lines.push(`\n🔴 **Deploy broken**: ${summary.failedDeployPRs.length} PR(s) have failed Vercel deployments. Spawn Dev or Ops to investigate.`);
    } else if (summary.readyForDev > 0) {
      lines.push(`\n**Action needed**: Spawn Dev to work on ready issues.`);
    }
    if (summary.prsAwaitingReview > 0) {
      lines.push(`**Action needed**: Spawn QA to review open PRs.`);
    }
    if (sprint?.status === "retro") {
      lines.push(`**Action needed**: Spawn PM to write Sprint retrospective.`);
    }
    if (sprint?.status === "review") {
      lines.push(`**Action needed**: Spawn QA to run UI acceptance tests on the deployed application.`);
    }
    if (!sprint) {
      lines.push(`**Action needed**: Spawn PM to plan Sprint 1.`);
    }
    if (summary.readyForDev === 0 && summary.prsAwaitingReview === 0 && summary.totalOpen === 0 && sprint?.status === "executing") {
      lines.push(`\nAll work complete for this Sprint. Consider starting retro early or planning ahead.`);
    }
  } catch (err) {
    lines.push(`\n### ⚠ Could not fetch GitHub state: ${err}`);
    lines.push(`You can manually check with: gh issue list / gh pr list`);
  }

  return lines.join("\n");
}

type GitHubState = {
  readyForDev: number;
  inProgress: number;
  prsAwaitingReview: number;
  prsApproved: number;
  totalOpen: number;
  p0Bugs: Array<{ number: number; title: string }>;
  failedDeployPRs: Array<{ number: number; title: string }>;
};

async function collectGitHubState(config: VirtuCorpConfig): Promise<GitHubState> {
  const [issuesRaw, prsRaw] = await Promise.all([
    gh(
      ["issue", "list", "--json", "number,title,labels", "--limit", "100", "--state", "open"],
      config.github,
    ).catch(() => "[]"),
    gh(
      ["pr", "list", "--json", "number,title,reviewDecision,statusCheckRollup", "--limit", "100", "--state", "open"],
      config.github,
    ).catch(() => "[]"),
  ]);

  const issues = JSON.parse(issuesRaw || "[]") as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;
  const prs = JSON.parse(prsRaw || "[]") as Array<{ number: number; title: string; reviewDecision: string; statusCheckRollup?: Array<{ conclusion: string; name: string }> }>;

  let readyForDev = 0;
  let inProgress = 0;
  const p0Bugs: Array<{ number: number; title: string }> = [];

  for (const issue of issues) {
    const names = issue.labels.map(l => l.name);
    if (names.includes("status/ready-for-dev")) readyForDev++;
    if (names.includes("status/in-progress")) inProgress++;
    if (names.includes("priority/p0") && names.includes("type/bug")) {
      p0Bugs.push({ number: issue.number, title: issue.title });
    }
  }

  let prsAwaitingReview = 0;
  let prsApproved = 0;
  const failedDeployPRs: Array<{ number: number; title: string }> = [];

  for (const pr of prs) {
    if (pr.reviewDecision === "APPROVED") prsApproved++;
    else prsAwaitingReview++;
    // Detect Vercel deployment failures
    const checks = pr.statusCheckRollup ?? [];
    const hasDeployFailure = checks.some(
      c => c.name.toLowerCase().includes("vercel") && c.conclusion === "FAILURE",
    );
    if (hasDeployFailure) {
      failedDeployPRs.push({ number: pr.number, title: pr.title });
    }
  }

  return {
    readyForDev,
    inProgress,
    prsAwaitingReview,
    prsApproved,
    totalOpen: issues.length,
    p0Bugs,
    failedDeployPRs,
  };
}

// ── Hook registration ───────────────────────────────────────

export function registerContextLoader(api: OpenClawPluginApi, config: VirtuCorpConfig) {
  api.on("before_prompt_build", async (_event, ctx) => {
    const role = getRoleMetadata(ctx.sessionKey);

    if (role) {
      // Sub-agent: inject role prompt + static project context (with identity)
      const rolePrompt = await loadRolePrompt(role);
      const projectContext = buildProjectContext(config, role);
      return {
        prependSystemContext: rolePrompt,
        prependContext: projectContext,
      };
    }

    // CEO session (main agent, no role metadata):
    // inject CEO prompt + live GitHub digest.
    // IMPORTANT: Only match sessions with "virtucorp-ceo" in the key —
    // otherwise private chat sessions get CEO prompts injected.
    const isCeoSession = ctx.sessionKey?.includes(CEO_AGENT_ID);
    if (isCeoSession && (ctx.trigger === "heartbeat" || ctx.trigger === "user")) {
      const ceoPrompt = await loadRolePrompt("ceo");
      const digest = await buildCEODigest(config);
      return {
        prependSystemContext: ceoPrompt,
        prependContext: digest,
      };
    }
  });
}

/**
 * Modification Tracker Hook (WTF-Likelihood)
 *
 * Tracks cumulative code modifications by the Dev agent within a session.
 * Inspired by gstack's WTF-Likelihood mechanism: after every N modifications,
 * compute a risk score. If modifications accumulate too much, pause and
 * escalate to prevent "fixing things into worse shape."
 *
 * Complementary to the circuit breaker (which detects "stuck in same state"):
 * - Circuit breaker prevents: doing nothing repeatedly
 * - WTF-Likelihood prevents: changing too much, too fast
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getRoleMetadata } from "../lib/role-metadata.js";

const execFileAsync = promisify(execFile);

// ── Configuration ───────────────────────────────────────────

const CHECK_INTERVAL = 5; // Check risk every N code modification commands
const MAX_FILES_CHANGED = 15; // Warn threshold: too many files touched
const MAX_LINES_CHANGED = 500; // Warn threshold: too many lines changed
const HARD_CAP_MODIFICATIONS = 50; // Hard stop: block after this many modifications

// ── Per-session tracking state ──────────────────────────────

type SessionStats = {
  modificationCount: number;
  paused: boolean;
};

const sessionStats = new Map<string, SessionStats>();

/** Pattern to detect code modification commands (OpenCode invocations). */
const OPENCODE_PATTERN = /\bopencode\b/;

/** Get or create stats for a session. */
function getStats(sessionKey: string): SessionStats {
  let stats = sessionStats.get(sessionKey);
  if (!stats) {
    stats = { modificationCount: 0, paused: false };
    sessionStats.set(sessionKey, stats);
  }
  return stats;
}

/** Clear stats when a session ends. */
export function clearSessionStats(sessionKey: string): void {
  sessionStats.delete(sessionKey);
}

/** Reset all tracking state (for testing). */
export function _resetAllStats(): void {
  sessionStats.clear();
}

/** Get stats for a session (for testing). */
export function _getStats(sessionKey: string): SessionStats | undefined {
  return sessionStats.get(sessionKey);
}

// ── Git diff stats helper ───────────────────────────────────

type DiffStats = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};

async function getGitDiffStats(cwd: string): Promise<DiffStats | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--stat", "HEAD"],
      { cwd, timeout: 10_000 },
    );

    // Parse last line: " N files changed, M insertions(+), K deletions(-)"
    const match = stdout.match(
      /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
    );
    if (!match) return { filesChanged: 0, insertions: 0, deletions: 0 };

    return {
      filesChanged: parseInt(match[1], 10) || 0,
      insertions: parseInt(match[2], 10) || 0,
      deletions: parseInt(match[3], 10) || 0,
    };
  } catch {
    return null;
  }
}

// ── Hook registration ───────────────────────────────────────

export function registerModificationTracker(api: OpenClawPluginApi, projectDir: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.on("before_tool_call", async (event: any, ctx: any) => {
    const role = getRoleMetadata(ctx.sessionKey);
    if (role !== "dev") return;

    // Only track shell commands that invoke OpenCode
    const isShellTool =
      event.toolName === "execute_command" ||
      event.toolName === "shell" ||
      event.toolName === "bash";

    if (!isShellTool) return;

    const cmd = (event.params.command as string) ?? (event.params.cmd as string) ?? "";
    if (!OPENCODE_PATTERN.test(cmd)) return;

    const stats = getStats(ctx.sessionKey);

    // ── Hard cap: absolute maximum modifications ──
    if (stats.modificationCount >= HARD_CAP_MODIFICATIONS) {
      return {
        block: true,
        blockReason:
          `[VirtuCorp] ⚠️ WTF-Likelihood HARD CAP: Dev has made ${stats.modificationCount} code modifications in this session. ` +
          `This exceeds the safety limit of ${HARD_CAP_MODIFICATIONS}. ` +
          `Stop modifying code and submit what you have as a PR for QA review. ` +
          `If the task isn't complete, describe remaining work in the PR description.`,
      };
    }

    // ── Paused: previous risk check flagged this session ──
    if (stats.paused) {
      return {
        block: true,
        blockReason:
          `[VirtuCorp] ⚠️ WTF-Likelihood PAUSED: Your cumulative modifications have exceeded safe thresholds. ` +
          `Stop and submit your current work as a PR. ` +
          `Describe what still needs to be done in the PR description so QA can evaluate.`,
      };
    }

    // Increment counter
    stats.modificationCount++;

    // ── Periodic risk check every N modifications ──
    if (stats.modificationCount % CHECK_INTERVAL === 0) {
      const diff = await getGitDiffStats(projectDir);
      if (diff) {
        const totalLines = diff.insertions + diff.deletions;
        const riskFactors: string[] = [];

        if (diff.filesChanged > MAX_FILES_CHANGED) {
          riskFactors.push(
            `${diff.filesChanged} files changed (threshold: ${MAX_FILES_CHANGED})`,
          );
        }
        if (totalLines > MAX_LINES_CHANGED) {
          riskFactors.push(
            `${totalLines} lines changed (threshold: ${MAX_LINES_CHANGED})`,
          );
        }

        if (riskFactors.length > 0) {
          stats.paused = true;
          return {
            block: true,
            blockReason:
              `[VirtuCorp] ⚠️ WTF-Likelihood WARNING after ${stats.modificationCount} modifications:\n` +
              riskFactors.map(f => `  - ${f}`).join("\n") +
              `\n\nYour changes are getting large. Submit what you have as a PR now. ` +
              `If the task isn't complete, describe remaining work in the PR description.`,
          };
        }
      }
    }
  });

  // Clean up session stats when sub-agent ends
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.on("subagent_ended", (event: any) => {
    clearSessionStats(event.targetSessionKey);
  });
}

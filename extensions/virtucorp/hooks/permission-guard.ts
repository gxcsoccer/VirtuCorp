/**
 * before_tool_call hook: enforce role-based permissions.
 *
 * Two layers of protection:
 * 1. Gate vc_review_pr and vc_merge_pr to QA (and CEO for merge)
 * 2. Best-effort interception of shell commands that bypass the gate
 *    (e.g. a Dev agent running `gh pr merge` directly)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getRoleMetadata } from "../lib/role-metadata.js";

/** Patterns in shell commands that are restricted to specific roles. */
const SHELL_DENY_PATTERNS: Array<{ pattern: RegExp; allowedRoles: string[] }> = [
  { pattern: /\bgh\s+pr\s+merge\b/, allowedRoles: ["qa"] },
  { pattern: /\bgh\s+pr\s+review\b.*--approve\b/, allowedRoles: ["qa"] },
  { pattern: /\bvercel\b/, allowedRoles: ["ops"] },
];

export function registerPermissionGuard(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event, ctx) => {
    const role = getRoleMetadata(ctx.sessionKey);
    if (!role) return; // CEO session — unrestricted

    // ── Gate registered vc_* tools ──────────────────────────

    if (event.toolName === "vc_review_pr") {
      if (role !== "qa") {
        return {
          block: true,
          blockReason: `[VirtuCorp] Only QA can review PRs. Your role: ${role}`,
        };
      }
    }

    if (event.toolName === "vc_merge_pr") {
      if (role !== "qa") {
        return {
          block: true,
          blockReason: `[VirtuCorp] Only QA can merge PRs. Your role: ${role}`,
        };
      }
    }

    // ── Best-effort shell command interception ──────────────

    const isShellTool =
      event.toolName === "execute_command" ||
      event.toolName === "shell" ||
      event.toolName === "bash";

    if (isShellTool) {
      const cmd =
        (event.params.command as string) ??
        (event.params.cmd as string) ??
        "";

      for (const { pattern, allowedRoles } of SHELL_DENY_PATTERNS) {
        if (pattern.test(cmd) && !allowedRoles.includes(role)) {
          return {
            block: true,
            blockReason: `[VirtuCorp] Role "${role}" cannot run this command. Use the appropriate vc_* tool or ask CEO to delegate.`,
          };
        }
      }
    }
  });
}

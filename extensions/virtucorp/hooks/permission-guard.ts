/**
 * before_tool_call hook: enforce role-based permissions.
 *
 * Three layers of protection:
 * 1. Gate vc_review_pr and vc_merge_pr to QA (and CEO for merge)
 * 2. Best-effort interception of shell commands that bypass the gate
 *    (e.g. a Dev agent running `gh pr merge` directly)
 * 3. Constitutional guard: block agents from modifying their own permission
 *    rules or safety-critical files
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getRoleMetadata } from "../lib/role-metadata.js";
import { CEO_AGENT_ID } from "../lib/types.js";

/** Patterns in shell commands that are restricted to specific roles. */
const SHELL_DENY_PATTERNS: Array<{ pattern: RegExp; allowedRoles: string[] }> = [
  { pattern: /\bgh\s+pr\s+merge\b/, allowedRoles: ["qa"] },
  { pattern: /\bgh\s+pr\s+review\b.*--approve\b/, allowedRoles: ["qa"] },
  { pattern: /\bvercel\b/, allowedRoles: ["ops"] },
];

/** Files that no agent (including CEO) may modify — constitutional guard. */
const PROTECTED_FILE_PATTERNS = [
  /permission-guard\.ts/,
  /permission-guard\.test\.ts/,
];

/** Source code file extensions that CEO must NOT read or modify. */
const SOURCE_CODE_PATTERN = /\.(tsx?|jsx?|css|scss|vue|svelte|json)$/i;

/** Paths CEO IS allowed to read (config, sprint state, knowledge). */
const CEO_ALLOWED_PATH_PATTERNS = [
  /\.virtucorp\//,
  /package\.json$/,
  /vercel\.json$/,
  /\.opencode\.json$/,
];

export function registerPermissionGuard(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event, ctx) => {
    const role = getRoleMetadata(ctx.sessionKey);

    // ── CEO code access guard ──────────────────────────────
    // CEO must delegate code work to Dev. Block read/write/edit on source code files.
    const isCeoSession = !role && ctx.sessionKey?.includes(CEO_AGENT_ID);
    if (isCeoSession) {
      const toolName = event.toolName;
      const isCodeTool = toolName === "read" || toolName === "write" || toolName === "edit" || toolName === "apply_patch";
      if (isCodeTool) {
        const filePath = (event.params.file_path as string) ?? (event.params.path as string) ?? "";
        const isSourceCode = SOURCE_CODE_PATTERN.test(filePath);
        const isAllowed = CEO_ALLOWED_PATH_PATTERNS.some(p => p.test(filePath));
        if (isSourceCode && !isAllowed) {
          return {
            block: true,
            blockReason: `[VirtuCorp] CEO cannot read or modify source code. Spawn Dev (vc:dev) to handle code changes. File: ${filePath}`,
          };
        }
      }
      // CEO also cannot run build/test commands
      const isShellTool = toolName === "execute_command" || toolName === "shell" || toolName === "bash";
      if (isShellTool) {
        const cmd = (event.params.command as string) ?? (event.params.cmd as string) ?? "";
        if (/\b(npm\s+(run\s+)?(build|test|dev)|tsc|vite|vercel)\b/.test(cmd)) {
          return {
            block: true,
            blockReason: `[VirtuCorp] CEO cannot run build/test/deploy commands. Spawn the appropriate role agent.`,
          };
        }
      }
      return; // Other CEO operations are fine
    }

    if (!role) return; // Non-VirtuCorp session — unrestricted

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

    if (event.toolName === "vc_ui_accept" || event.toolName === "vc_ui_accept_run") {
      if (role !== "qa" && role !== "pm") {
        return {
          block: true,
          blockReason: `[VirtuCorp] Only QA and PM can run UI acceptance tests. Your role: ${role}`,
        };
      }
    }

    // ── Dev: block write/edit tools — must use OpenCode CLI instead ──
    if (role === "dev") {
      const isWriteTool =
        event.toolName === "write" ||
        event.toolName === "edit" ||
        event.toolName === "apply_patch";

      if (isWriteTool) {
        return {
          block: true,
          blockReason: `[VirtuCorp] Dev cannot use write/edit tools directly. Use OpenCode CLI (\`opencode -p "..." -q -c /path/to/project\`) for all code modifications. This ensures LSP diagnostics and higher code quality.`,
        };
      }
    }

    // ── Constitutional guard: protect safety-critical files ──

    const isWriteTool =
      event.toolName === "write" ||
      event.toolName === "edit" ||
      event.toolName === "apply_patch";

    if (isWriteTool) {
      const filePath =
        (event.params.file_path as string) ??
        (event.params.path as string) ??
        "";

      for (const pattern of PROTECTED_FILE_PATTERNS) {
        if (pattern.test(filePath)) {
          return {
            block: true,
            blockReason: `[VirtuCorp] Constitutional guard: "${filePath}" is a protected safety file. Only the investor can modify it.`,
          };
        }
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

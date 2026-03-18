/**
 * before_tool_call hook: pre-spawn cleanup.
 *
 * When CEO calls sessions_spawn with a vc:* label, proactively delete
 * any existing session for that role BEFORE the spawn executes.
 * This prevents "label already in use" errors from zombie sessions.
 *
 * Covers tracked sessions (in metadata) and is the primary defense
 * against session label deadlocks.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getActiveSessions, clearRoleMetadata } from "../lib/role-metadata.js";
import { VIRTUCORP_ROLES, type VirtuCorpRole } from "../lib/types.js";

const VC_LABEL_PREFIX = "vc:";

/** Tool names that might represent session spawn operations. */
const SPAWN_TOOL_NAMES = [
  "sessions_spawn",
  "sessions_patch",
  "spawn_subagent",
  "subagent_spawn",
];

export function registerSpawnCleanup(api: OpenClawPluginApi) {
  api.on("before_tool_call", async (event, _ctx) => {
    // Only intercept spawn-like tool calls
    if (!SPAWN_TOOL_NAMES.includes(event.toolName)) return;

    // Extract the label from params (could be "label", "labels", or part of task)
    const label =
      (event.params.label as string) ??
      (event.params.labels as string) ??
      "";

    if (!label.startsWith(VC_LABEL_PREFIX)) return;

    const role = label.slice(VC_LABEL_PREFIX.length) as VirtuCorpRole;
    if (!VIRTUCORP_ROLES.includes(role)) return;

    // Check if there's already a tracked session for this role
    const activeSessions = getActiveSessions();
    const existing = activeSessions.get(role);
    if (!existing) return; // No conflict, let spawn proceed

    // Proactively clean up the old session to prevent "label already in use"
    api.logger.warn(
      `VirtuCorp spawn-cleanup: vc:${role} label occupied by ${existing.sessionKey} (${existing.ageMinutes}min old). Deleting before spawn.`,
    );

    clearRoleMetadata(existing.sessionKey);
    try {
      await api.runtime.subagent.deleteSession({ sessionKey: existing.sessionKey });
      api.logger.info(
        `VirtuCorp spawn-cleanup: deleted ${existing.sessionKey}, vc:${role} label freed.`,
      );
    } catch (err) {
      api.logger.warn(
        `VirtuCorp spawn-cleanup: failed to delete ${existing.sessionKey}: ${err}`,
      );
    }

    // Don't block — let the spawn proceed
  });
}

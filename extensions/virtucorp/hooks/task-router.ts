/**
 * subagent_ended hook: clean up role metadata when a sub-agent finishes.
 *
 * Also deletes the OpenClaw session to free the role label (vc:dev, vc:qa, etc.)
 * so the CEO can immediately spawn a new sub-agent with the same role.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { clearRoleMetadata, getRoleMetadata } from "../lib/role-metadata.js";

export function registerTaskRouter(api: OpenClawPluginApi) {
  api.on("subagent_ended", async (event, _ctx) => {
    const sessionKey = event.targetSessionKey;
    const role = getRoleMetadata(sessionKey);
    if (!role) return; // Not a VirtuCorp sub-agent

    const outcome = event.outcome ?? "unknown";
    if (outcome === "ok") {
      api.logger.info(`VirtuCorp: ${role} sub-agent completed successfully`);
    } else {
      api.logger.warn(
        `VirtuCorp: ${role} sub-agent ended with outcome "${outcome}"` +
        (event.error ? `: ${event.error}` : ""),
      );
    }

    clearRoleMetadata(sessionKey);

    // Delete the actual OpenClaw session to free the role label.
    // Without this, the label (e.g. "vc:dev") stays registered and blocks
    // future spawns with "label already in use".
    if (outcome !== "deleted") {
      try {
        await api.runtime.subagent.deleteSession({ sessionKey });
        api.logger.info(`VirtuCorp: deleted session ${sessionKey} to free vc:${role} label`);
      } catch (err) {
        api.logger.warn(`VirtuCorp: failed to delete session ${sessionKey}: ${err}`);
      }
    }
  });
}

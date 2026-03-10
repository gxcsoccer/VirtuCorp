/**
 * subagent_ended hook: clean up role metadata when a sub-agent finishes.
 *
 * Also logs the outcome for debugging and future budget tracking.
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
  });
}

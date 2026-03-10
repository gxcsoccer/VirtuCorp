/**
 * subagent_spawning hook: inject role metadata when CEO spawns a role sub-agent.
 *
 * CEO spawns sub-agents with a label like "vc:pm", "vc:dev", "vc:qa", "vc:ops".
 * This hook parses the label and stores the role mapping.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { setRoleMetadata } from "../lib/role-metadata.js";
import { VIRTUCORP_ROLES, type VirtuCorpRole } from "../lib/types.js";

const VC_LABEL_PREFIX = "vc:";

export function registerRoleInjector(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event, _ctx) => {
    const label = event.label;
    if (!label?.startsWith(VC_LABEL_PREFIX)) return;

    const role = label.slice(VC_LABEL_PREFIX.length) as VirtuCorpRole;
    if (!VIRTUCORP_ROLES.includes(role)) {
      return { status: "error" as const, error: `Unknown VirtuCorp role: ${role}` };
    }

    // Store the role for this session so other hooks can look it up
    setRoleMetadata(event.childSessionKey, role);
    api.logger.info(`VirtuCorp: sub-agent ${event.childSessionKey} assigned role "${role}"`);

    return { status: "ok" as const };
  });
}

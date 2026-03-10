/**
 * before_model_resolve hook: route sub-agents to role-specific models.
 *
 * When a sub-agent session has role metadata (set by role-injector),
 * this hook overrides the model to the one configured for that role.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getRoleMetadata } from "../lib/role-metadata.js";
import type { VirtuCorpConfig, VirtuCorpRole } from "../lib/types.js";

export function registerModelRouter(api: OpenClawPluginApi, config: VirtuCorpConfig) {
  api.on("before_model_resolve", async (_event, ctx) => {
    const role = getRoleMetadata(ctx.sessionKey) as VirtuCorpRole | undefined;
    if (!role) return; // CEO session — use default model

    const roleConfig = config.roles[role];
    if (!roleConfig?.model) return; // No model override configured

    api.logger.debug(`VirtuCorp model-router: ${role} → ${roleConfig.model}`);

    return {
      modelOverride: roleConfig.model,
    };
  });
}

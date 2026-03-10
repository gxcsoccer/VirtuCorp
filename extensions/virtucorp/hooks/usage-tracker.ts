/**
 * llm_output hook: track token usage per role for budget monitoring.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getRoleMetadata } from "../lib/role-metadata.js";
import type { BudgetConfig, VirtuCorpRole } from "../lib/types.js";

type UsageRecord = {
  role: VirtuCorpRole;
  tokens: number;
  model: string;
  timestamp: number;
};

class BudgetMonitor {
  private records: UsageRecord[] = [];
  private dailyLimit: number;
  private readonly TOKENS_PER_USD = 1_000_000; // rough estimate, varies by model

  constructor(config: BudgetConfig) {
    this.dailyLimit = config.dailyLimitUsd;
  }

  record(entry: UsageRecord): void {
    this.records.push(entry);
    this.pruneOldRecords();
  }

  getTodayUsage(): { tokens: number; estimatedUsd: number } {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    const todayTokens = this.records
      .filter(r => r.timestamp >= todayMs)
      .reduce((sum, r) => sum + r.tokens, 0);

    return {
      tokens: todayTokens,
      estimatedUsd: todayTokens / this.TOKENS_PER_USD,
    };
  }

  isDailyLimitExceeded(): boolean {
    return this.getTodayUsage().estimatedUsd >= this.dailyLimit;
  }

  private pruneOldRecords(): void {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    this.records = this.records.filter(r => r.timestamp >= threeDaysAgo);
  }
}

export function registerUsageTracker(api: OpenClawPluginApi, budgetConfig: BudgetConfig) {
  const monitor = new BudgetMonitor(budgetConfig);

  api.on("llm_output", async (event, ctx) => {
    const role = getRoleMetadata(ctx.sessionKey);
    if (!role) return; // Not a VirtuCorp sub-agent

    const tokens = event.usage?.total ?? 0;
    if (tokens === 0) return;

    monitor.record({
      role,
      tokens,
      model: event.model,
      timestamp: Date.now(),
    });

    if (monitor.isDailyLimitExceeded()) {
      const usage = monitor.getTodayUsage();
      api.logger.warn(
        `VirtuCorp: daily budget limit exceeded! ` +
        `Used ~$${usage.estimatedUsd.toFixed(2)} / $${budgetConfig.dailyLimitUsd} limit`,
      );
    }
  });

  return monitor;
}

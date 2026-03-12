/**
 * Permission-gated GitHub PR tools.
 *
 * Only review and merge are registered as vc_* tools — these are the
 * quality gates that must be enforced architecturally.
 * All other GitHub operations (list issues, create PR, etc.) are done
 * by agents directly via the `gh` CLI.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { gh } from "../lib/github-client.js";
import type { GitHubConfig } from "../lib/types.js";

export function registerPRTools(api: OpenClawPluginApi, githubConfig: GitHubConfig) {
  api.registerTool(() => ({
    name: "vc_review_pr",
    description:
      "Submit a review on a pull request. Use 'approve' to approve, 'request-changes' to request fixes, or 'comment' for general feedback. Only QA role can use this.",
    parameters: {
      type: "object" as const,
      properties: {
        pr_number: { type: "number", description: "PR number" },
        action: {
          type: "string",
          enum: ["approve", "request-changes", "comment"],
          description: "Review action",
        },
        body: {
          type: "string",
          description: "Review comment. Required for request-changes and comment.",
        },
      },
      required: ["pr_number", "action"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const prNumber = String(args.pr_number);
      const action = args.action as string;
      const body = args.body as string | undefined;

      const ghArgs = ["pr", "review", prNumber, `--${action}`];
      if (body) ghArgs.push("--body", body);

      const result = await gh(ghArgs, githubConfig);
      return result || `Review submitted on PR #${prNumber}: ${action}`;
    },
  }));

  api.registerTool(() => ({
    name: "vc_merge_pr",
    description:
      "Merge an approved pull request. Uses squash merge and deletes the branch. Only QA and CEO can use this.",
    parameters: {
      type: "object" as const,
      properties: {
        pr_number: { type: "number", description: "PR number to merge" },
        method: {
          type: "string",
          enum: ["merge", "squash", "rebase"],
          description: "Merge method. Default: squash",
        },
      },
      required: ["pr_number"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const prNumber = String(args.pr_number);
      const method = (args.method as string) ?? "squash";

      const result = await gh(
        ["pr", "merge", prNumber, `--${method}`, "--delete-branch"],
        githubConfig,
      );
      return result || `Merged PR #${prNumber}`;
    },
  }));
}

/**
 * Shared types for the VirtuCorp plugin.
 */

export type VirtuCorpRole = "pm" | "dev" | "qa" | "ops";

export const VIRTUCORP_ROLES: readonly VirtuCorpRole[] = ["pm", "dev", "qa", "ops"] as const;

export type GitHubConfig = {
  owner: string;
  repo: string;
  webhookSecret?: string;
};

export type RoleConfig = {
  model?: string;
};

export type SprintConfig = {
  /** Sprint length in days. Set to 1 for daily iterations. */
  durationDays: number;
  autoRetro: boolean;
  /** How often the CEO checks GitHub for work (minutes). Auto-scales with sprint duration. */
  heartbeatMinutes: number;
};

export type BudgetConfig = {
  dailyLimitUsd: number;
  circuitBreakerRetries: number;
};

/**
 * Authentication configuration for E2E tests.
 * Defines login steps that can be prepended to tests requiring authentication.
 */
export type AuthStep = {
  /** Natural language action (e.g., "输入用户名 'test@example.com'") */
  ai?: string;
  /** Tap/click action */
  aiTap?: string;
  /** Input action with value */
  aiInput?: { element: string; value: string };
  /** Wait for condition */
  aiWaitFor?: string;
  /** Sleep for N milliseconds */
  sleep?: number;
};

export type AuthConfig = {
  /** Login URL to navigate to before performing auth steps */
  loginUrl?: string;
  /** Steps to perform authentication (e.g., enter credentials, click login) */
  steps: AuthStep[];
  /** Whether to store auth state for reuse across tests (default: true) */
  persistSession?: boolean;
};

export type VirtuCorpConfig = {
  github: GitHubConfig;
  projectDir: string;
  productionUrl?: string;
  sprint: SprintConfig;
  budget: BudgetConfig;
  roles: Record<VirtuCorpRole, RoleConfig>;
  /** Authentication configuration for E2E acceptance tests */
  auth?: AuthConfig;
};

export type SprintState = {
  current: number;
  startDate: string;
  endDate: string;
  milestone: number | null;
  status: "planning" | "executing" | "retro" | "review" | "completed";
};

/**
 * Label constants used by the GitHub state machine.
 */
export const CEO_AGENT_ID = "virtucorp-ceo";

export const LABELS = {
  // Status labels
  STATUS_READY: "status/ready-for-dev",
  STATUS_IN_PROGRESS: "status/in-progress",
  STATUS_IN_REVIEW: "status/in-review",
  STATUS_DONE: "status/done",

  // Priority labels
  PRIORITY_P0: "priority/p0",
  PRIORITY_P1: "priority/p1",
  PRIORITY_P2: "priority/p2",

  // Type labels
  TYPE_FEATURE: "type/feature",
  TYPE_BUG: "type/bug",
  TYPE_REFACTOR: "type/refactor",
  TYPE_CHORE: "type/chore",

  // Agent labels
  AGENT_PM: "agent/pm",
  AGENT_DEV: "agent/dev",
  AGENT_QA: "agent/qa",
  AGENT_OPS: "agent/ops",

  // Meta labels
  NEEDS_INVESTOR_APPROVAL: "needs-investor-approval",
  META_IMPROVEMENT: "type/meta-improvement",
} as const;

/**
 * Test helpers: mock OpenClaw plugin API and related types.
 */

import { vi } from "vitest";

type HookHandler = (...args: unknown[]) => unknown;

export type MockPluginApi = {
  id: string;
  name: string;
  config: Record<string, unknown>;
  pluginConfig: Record<string, unknown>;
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  registerHttpRoute: ReturnType<typeof vi.fn>;
  registerService: ReturnType<typeof vi.fn>;
  registerGatewayMethod: ReturnType<typeof vi.fn>;
  registerChannel: ReturnType<typeof vi.fn>;
  registerCli: ReturnType<typeof vi.fn>;
  registerProvider: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerContextEngine: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  resolvePath: ReturnType<typeof vi.fn>;
  runtime: Record<string, unknown>;
  // helpers for testing
  _hooks: Map<string, HookHandler[]>;
  _tools: Map<string, { handler: (args: Record<string, unknown>) => Promise<string> }>;
  _getHook: (name: string) => HookHandler | undefined;
  _callHook: (name: string, event: unknown, ctx: unknown) => Promise<unknown>;
  _getTool: (name: string) => { handler: (args: Record<string, unknown>) => Promise<string> } | undefined;
};

export function createMockPluginApi(pluginConfig?: Record<string, unknown>): MockPluginApi {
  const hooks = new Map<string, HookHandler[]>();
  const tools = new Map<string, { handler: (args: Record<string, unknown>) => Promise<string> }>();

  const api: MockPluginApi = {
    id: "virtucorp",
    name: "VirtuCorp",
    config: {},
    pluginConfig: pluginConfig ?? {
      github: { owner: "test-owner", repo: "test-repo" },
      projectDir: "/tmp/test-project",
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: vi.fn((factoryOrTool: unknown) => {
      if (typeof factoryOrTool === "function") {
        const tool = (factoryOrTool as (ctx: Record<string, unknown>) => { name: string; handler: (args: Record<string, unknown>) => Promise<string> })({});
        if (tool) {
          tools.set(tool.name, tool);
        }
      }
    }),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      const list = hooks.get(hookName) ?? [];
      list.push(handler);
      hooks.set(hookName, list);
    }),
    registerHttpRoute: vi.fn(),
    registerService: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerChannel: vi.fn(),
    registerCli: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerHook: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    runtime: {},
    // Test helpers
    _hooks: hooks,
    _tools: tools,
    _getHook(name: string) {
      return hooks.get(name)?.[0];
    },
    async _callHook(name: string, event: unknown, ctx: unknown) {
      const handler = hooks.get(name)?.[0];
      if (!handler) return undefined;
      return await handler(event, ctx);
    },
    _getTool(name: string) {
      return tools.get(name);
    },
  };

  return api;
}

export function makeAgentContext(opts: { sessionKey?: string; sessionId?: string } = {}) {
  return {
    agentId: "test-agent",
    sessionKey: opts.sessionKey ?? "session-1",
    sessionId: opts.sessionId ?? "sid-1",
  };
}

export function makeSubagentSpawningEvent(opts: {
  label?: string;
  childSessionKey?: string;
  agentId?: string;
}) {
  return {
    childSessionKey: opts.childSessionKey ?? "child-session-1",
    agentId: opts.agentId ?? "test-agent",
    label: opts.label,
    mode: "run" as const,
  };
}

export function makeSubagentEndedEvent(opts: {
  targetSessionKey?: string;
  outcome?: string;
  error?: string;
}) {
  return {
    targetSessionKey: opts.targetSessionKey ?? "child-session-1",
    targetKind: "subagent" as const,
    reason: "completed",
    outcome: opts.outcome ?? "ok",
    error: opts.error,
  };
}

export function makeToolCallEvent(opts: {
  toolName: string;
  params?: Record<string, unknown>;
}) {
  return {
    toolName: opts.toolName,
    params: opts.params ?? {},
  };
}

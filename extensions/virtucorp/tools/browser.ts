/**
 * Persistent Browser Tool — `vc_browse`
 *
 * Provides QA and PM agents with a persistent headless browser for
 * interactive testing. Unlike MidsceneJS (which spawns a new browser
 * per test run), this tool keeps a long-lived Chromium instance with
 * ~100-200ms command latency after initial startup.
 *
 * Key features:
 * - Accessibility tree snapshots with @ref element references
 * - Direct click/type via @ref (no CSS selectors needed)
 * - Console log and network error capture
 * - Multi-tab support
 * - Screenshots for visual verification
 *
 * Usage pattern for agents:
 *   1. navigate to URL
 *   2. snapshot to see page structure with @refs
 *   3. click/type using @refs to interact
 *   4. screenshot for visual evidence
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getBrowserManager } from "../lib/browser-manager.js";

export function registerBrowserTools(api: OpenClawPluginApi) {
  api.registerTool(() => ({
    name: "vc_browse",
    description:
      "Interact with a persistent headless browser. Supports actions: " +
      "navigate, snapshot, click, type, screenshot, console, network, " +
      "evaluate, tabs, close_tab. Use snapshot to get @refs, then click/type by @ref. " +
      "Only QA and PM roles can use this tool.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "navigate",
            "snapshot",
            "click",
            "type",
            "screenshot",
            "console",
            "network",
            "evaluate",
            "tabs",
            "close_tab",
          ],
          description:
            "The browser action to perform. " +
            "navigate: go to a URL. " +
            "snapshot: get accessibility tree with @ref labels for interactive elements. " +
            "click: click element by @ref (from last snapshot). " +
            "type: type text into element by @ref. " +
            "screenshot: capture page as base64 PNG. " +
            "console: show recent console logs. " +
            "network: show recent network errors (4xx/5xx). " +
            "evaluate: run JavaScript in page context. " +
            "tabs: list open tabs. " +
            "close_tab: close a specific tab.",
        },
        url: {
          type: "string",
          description: "URL to navigate to (for 'navigate' action)",
        },
        ref: {
          type: "string",
          description:
            "Element reference from snapshot, e.g. '@e5' (for 'click' and 'type' actions)",
        },
        text: {
          type: "string",
          description: "Text to type (for 'type' action)",
        },
        javascript: {
          type: "string",
          description: "JavaScript code to evaluate (for 'evaluate' action)",
        },
        tab: {
          type: "string",
          description:
            "Tab ID (default: 'main'). Use different IDs to open multiple tabs.",
        },
        full_page: {
          type: "boolean",
          description:
            "Whether to capture full page screenshot (default: false, viewport only)",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const action = args.action as string;
      const tab = args.tab as string | undefined;
      const manager = getBrowserManager();

      try {
        switch (action) {
          case "navigate": {
            const url = args.url as string | undefined;
            if (!url) return "Error: 'url' parameter is required for navigate action.";
            return await manager.navigate(url, tab);
          }

          case "snapshot": {
            return await manager.snapshot(tab);
          }

          case "click": {
            const ref = args.ref as string | undefined;
            if (!ref) return "Error: 'ref' parameter is required for click action (e.g. '@e5').";
            return await manager.click(ref, tab);
          }

          case "type": {
            const ref = args.ref as string | undefined;
            const text = args.text as string | undefined;
            if (!ref) return "Error: 'ref' parameter is required for type action.";
            if (text === undefined) return "Error: 'text' parameter is required for type action.";
            return await manager.type(ref, text, tab);
          }

          case "screenshot": {
            const fullPage = args.full_page as boolean | undefined;
            const base64 = await manager.screenshot(tab, fullPage ?? false);
            if (base64.startsWith("Screenshot error:")) return base64;
            // Return as a data URL that the agent can embed or reference
            return `data:image/png;base64,${base64}`;
          }

          case "console": {
            return manager.getConsoleLogs();
          }

          case "network": {
            return manager.getNetworkErrors();
          }

          case "evaluate": {
            const js = args.javascript as string | undefined;
            if (!js) return "Error: 'javascript' parameter is required for evaluate action.";
            return await manager.evaluate(js, tab);
          }

          case "tabs": {
            return manager.listTabs();
          }

          case "close_tab": {
            const tabId = tab ?? args.ref as string;
            if (!tabId) return "Error: 'tab' parameter is required for close_tab action.";
            return await manager.closeTab(tabId);
          }

          default:
            return `Error: unknown action "${action}". Valid actions: navigate, snapshot, click, type, screenshot, console, network, evaluate, tabs, close_tab.`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Browser error: ${msg}`;
      }
    },
  }));
}

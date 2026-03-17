/**
 * Persistent Browser Manager
 *
 * Manages a long-lived headless Chromium instance via Playwright.
 * Key features:
 * - Lazy browser launch (first use triggers startup)
 * - Multi-tab support via tab IDs
 * - Accessibility tree snapshots with @ref element references
 * - Console & network error circular buffers
 * - Auto-restart on browser crash
 *
 * Inspired by gstack's persistent browser daemon, adapted for
 * in-process use within the OpenClaw plugin.
 */

// Playwright types declared inline to avoid hard dependency on the package.
// The actual `playwright` module is dynamically imported at runtime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Browser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserContext = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;

// ── Types ───────────────────────────────────────────────────

export type RefInfo = {
  role: string;
  name: string;
  nth: number; // 0-based index among elements with same role+name on page
};

export type SnapshotNode = {
  role: string;
  name: string;
  value?: string;
  ref?: string;
  children?: SnapshotNode[];
};

type ConsoleEntry = {
  type: string;
  text: string;
  timestamp: number;
};

type NetworkError = {
  url: string;
  status: number;
  statusText: string;
  timestamp: number;
};

// ── Circular Buffer ─────────────────────────────────────────

export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private _size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  getAll(): T[] {
    if (this._size === 0) return [];
    if (this._size < this.capacity) {
      return this.buffer.slice(0, this._size) as T[];
    }
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head),
    ] as T[];
  }

  get size(): number {
    return this._size;
  }

  clear(): void {
    this.head = 0;
    this._size = 0;
  }
}

// ── Interactive roles that get @ref assignments ─────────────

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
]);

// ── Browser Manager ─────────────────────────────────────────

const DEFAULT_TAB = "main";
const CONSOLE_BUFFER_SIZE = 1000;
const NETWORK_BUFFER_SIZE = 500;

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages = new Map<string, Page>();
  private refMap = new Map<string, RefInfo>();
  private refCounter = 0;
  private consoleLogs = new CircularBuffer<ConsoleEntry>(CONSOLE_BUFFER_SIZE);
  private networkErrors = new CircularBuffer<NetworkError>(NETWORK_BUFFER_SIZE);
  private launching = false;

  /** Lazy-init: launch browser on first use. */
  async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.launching) {
      // Wait for in-flight launch
      while (this.launching) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (this.browser?.isConnected()) return this.browser;
    }

    this.launching = true;
    try {
      // Dynamic import so playwright is only loaded when needed
      const pw = await import("playwright");
      this.browser = await pw.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      // Handle browser disconnect (crash recovery)
      this.browser.on("disconnected", () => {
        this.browser = null;
        this.context = null;
        this.pages.clear();
        this.refMap.clear();
      });

      return this.browser;
    } finally {
      this.launching = false;
    }
  }

  /** Get or create a page (tab) by ID. */
  async getPage(tabId: string = DEFAULT_TAB): Promise<Page> {
    const existing = this.pages.get(tabId);
    if (existing && !existing.isClosed()) return existing;

    await this.ensureBrowser();
    const page = await this.context!.newPage();

    // Attach console listener
    page.on("console", (msg) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });

    // Attach network error listener
    page.on("response", (response) => {
      if (response.status() >= 400) {
        this.networkErrors.push({
          url: response.url(),
          status: response.status(),
          statusText: response.statusText(),
          timestamp: Date.now(),
        });
      }
    });

    this.pages.set(tabId, page);
    return page;
  }

  /** Navigate to a URL. */
  async navigate(url: string, tabId?: string): Promise<string> {
    const page = await this.getPage(tabId);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Wait a bit for dynamic content
      await page.waitForTimeout(1000);
      return `Navigated to ${page.url()} — "${await page.title()}"`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Navigation error: ${msg}`;
    }
  }

  /**
   * Build a text snapshot of the current page's accessibility tree.
   * Uses Playwright's ariaSnapshot() API, then parses the output to assign
   * @ref labels to interactive elements for subsequent click/type commands.
   */
  async snapshot(tabId?: string): Promise<string> {
    const page = await this.getPage(tabId);
    this.refMap.clear();
    this.refCounter = 0;

    try {
      const ariaText: string = await page.locator(":root").ariaSnapshot();
      if (!ariaText || !ariaText.trim()) return "[empty page — no accessibility tree]";

      // Parse ariaSnapshot output and assign @refs to interactive elements
      const annotated = this.annotateAriaSnapshot(ariaText);

      const header = `Page: "${await page.title()}" (${page.url()})`;
      return `${header}\n${"─".repeat(60)}\n${annotated}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Snapshot error: ${msg}`;
    }
  }

  /** Click an element by @ref. */
  async click(ref: string, tabId?: string): Promise<string> {
    const info = this.refMap.get(ref);
    if (!info) return `Error: ref "${ref}" not found. Run snapshot first to get current refs.`;

    const page = await this.getPage(tabId);
    try {
      const locator = page.getByRole(info.role as string, {
        name: info.name,
        exact: false,
      }).nth(info.nth);

      await locator.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      return `Clicked ${ref} (${info.role}: "${info.name}")`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Click error on ${ref}: ${msg}`;
    }
  }

  /** Type text into an element by @ref. */
  async type(ref: string, text: string, tabId?: string): Promise<string> {
    const info = this.refMap.get(ref);
    if (!info) return `Error: ref "${ref}" not found. Run snapshot first to get current refs.`;

    const page = await this.getPage(tabId);
    try {
      const locator = page.getByRole(info.role as string, {
        name: info.name,
        exact: false,
      }).nth(info.nth);

      await locator.fill(text, { timeout: 5000 });
      return `Typed "${text}" into ${ref} (${info.role}: "${info.name}")`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Type error on ${ref}: ${msg}`;
    }
  }

  /** Take a screenshot, return base64 PNG. */
  async screenshot(tabId?: string, fullPage = false): Promise<string> {
    const page = await this.getPage(tabId);
    try {
      const buffer = await page.screenshot({ fullPage, type: "png" });
      return buffer.toString("base64");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Screenshot error: ${msg}`;
    }
  }

  /** Evaluate JavaScript in the page context. */
  async evaluate(js: string, tabId?: string): Promise<string> {
    const page = await this.getPage(tabId);
    try {
      const result = await page.evaluate(js);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Evaluate error: ${msg}`;
    }
  }

  /** Get recent console logs. */
  getConsoleLogs(limit = 50): string {
    const logs = this.consoleLogs.getAll();
    const recent = logs.slice(-limit);
    if (recent.length === 0) return "No console logs captured.";
    return recent
      .map((e) => `[${e.type}] ${e.text}`)
      .join("\n");
  }

  /** Get recent network errors. */
  getNetworkErrors(limit = 30): string {
    const errors = this.networkErrors.getAll();
    const recent = errors.slice(-limit);
    if (recent.length === 0) return "No network errors captured.";
    return recent
      .map((e) => `${e.status} ${e.statusText} — ${e.url}`)
      .join("\n");
  }

  /** List open tabs. */
  listTabs(): string {
    const entries: string[] = [];
    for (const [id, page] of this.pages) {
      if (!page.isClosed()) {
        entries.push(`  ${id}: ${page.url()}`);
      }
    }
    return entries.length > 0
      ? `Open tabs:\n${entries.join("\n")}`
      : "No open tabs.";
  }

  /** Close a specific tab. */
  async closeTab(tabId: string): Promise<string> {
    const page = this.pages.get(tabId);
    if (!page) return `No tab with id "${tabId}".`;
    if (!page.isClosed()) await page.close();
    this.pages.delete(tabId);
    return `Closed tab "${tabId}".`;
  }

  /** Shut down the browser entirely. */
  async close(): Promise<void> {
    for (const [, page] of this.pages) {
      if (!page.isClosed()) await page.close().catch(() => {});
    }
    this.pages.clear();
    this.refMap.clear();
    this.consoleLogs.clear();
    this.networkErrors.clear();

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /** Whether the browser is currently running. */
  get isRunning(): boolean {
    return this.browser?.isConnected() === true;
  }

  // ── Private: ariaSnapshot annotator ─────────────────────

  /**
   * Parse Playwright's ariaSnapshot text output and prepend @ref labels
   * to interactive elements. ariaSnapshot format example:
   *   - heading "Example Domain" [level=1]
   *   - link "Learn more":
   *     - /url: https://example.com
   *
   * We match lines like `- <role> "name"` where role is interactive,
   * and prepend [@eN] for the agent to reference.
   */
  private annotateAriaSnapshot(ariaText: string): string {
    const lines = ariaText.split("\n");
    const result: string[] = [];

    // Pattern: captures leading whitespace + "- role" + optional quoted name
    const linePattern = /^(\s*-\s+)(\w+)(?:\s+"([^"]*)")?(.*)$/;

    for (const line of lines) {
      const match = line.match(linePattern);
      if (match) {
        const [, prefix, role, name, rest] = match;
        if (INTERACTIVE_ROLES.has(role) && name) {
          this.refCounter++;
          const ref = `@e${this.refCounter}`;

          // Count how many elements with same role+name we've seen
          let nth = 0;
          for (const [, info] of this.refMap) {
            if (info.role === role && info.name === name) nth++;
          }

          this.refMap.set(ref, { role, name, nth });
          result.push(`${prefix}[${ref}] ${role} "${name}"${rest}`);
          continue;
        }
      }
      result.push(line);
    }

    return result.join("\n");
  }
}

// ── Singleton instance ──────────────────────────────────────

let instance: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!instance) {
    instance = new BrowserManager();
  }
  return instance;
}

export async function shutdownBrowserManager(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

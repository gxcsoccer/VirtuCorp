import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  setRoleMetadata,
  getRoleMetadata,
  clearRoleMetadata,
  setAssignedIssue,
  getAssignedIssue,
  initPersistence,
  getStaleSessions,
} from "./role-metadata.js";

describe("role-metadata", () => {
  const SESSION_KEY = "test-session-1";

  beforeEach(() => {
    clearRoleMetadata(SESSION_KEY);
  });

  test("returns undefined for unknown session", () => {
    expect(getRoleMetadata("unknown")).toBeUndefined();
  });

  test("returns undefined for undefined session key", () => {
    expect(getRoleMetadata(undefined)).toBeUndefined();
  });

  test("stores and retrieves role", () => {
    setRoleMetadata(SESSION_KEY, "dev");
    expect(getRoleMetadata(SESSION_KEY)).toBe("dev");
  });

  test("overwrites role on same session", () => {
    setRoleMetadata(SESSION_KEY, "dev");
    setRoleMetadata(SESSION_KEY, "qa");
    expect(getRoleMetadata(SESSION_KEY)).toBe("qa");
  });

  test("clears role and issue data", () => {
    setRoleMetadata(SESSION_KEY, "pm");
    setAssignedIssue(SESSION_KEY, 42);
    clearRoleMetadata(SESSION_KEY);
    expect(getRoleMetadata(SESSION_KEY)).toBeUndefined();
    expect(getAssignedIssue(SESSION_KEY)).toBeUndefined();
  });

  test("clearRoleMetadata is safe with undefined", () => {
    expect(() => clearRoleMetadata(undefined)).not.toThrow();
  });

  test("stores and retrieves assigned issue", () => {
    setAssignedIssue(SESSION_KEY, 7);
    expect(getAssignedIssue(SESSION_KEY)).toBe(7);
  });

  test("getAssignedIssue returns undefined for unset session", () => {
    expect(getAssignedIssue("no-such-session")).toBeUndefined();
  });

  test("isolates data between sessions", () => {
    setRoleMetadata("session-a", "dev");
    setRoleMetadata("session-b", "qa");
    setAssignedIssue("session-a", 1);
    setAssignedIssue("session-b", 2);

    expect(getRoleMetadata("session-a")).toBe("dev");
    expect(getRoleMetadata("session-b")).toBe("qa");
    expect(getAssignedIssue("session-a")).toBe(1);
    expect(getAssignedIssue("session-b")).toBe(2);

    clearRoleMetadata("session-a");
    expect(getRoleMetadata("session-a")).toBeUndefined();
    expect(getRoleMetadata("session-b")).toBe("qa");
  });
});

describe("role-metadata persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-meta-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("persists metadata to disk and reloads on init", async () => {
    // Clear any leftover in-memory state from other tests
    clearRoleMetadata("session-a");
    clearRoleMetadata("session-b");
    clearRoleMetadata("test-session-1");
    clearRoleMetadata("old-qa-session");

    // Init persistence and save a session
    await initPersistence(tmpDir);
    setRoleMetadata("persist-session", "dev");

    // Wait for async save to complete
    await new Promise(r => setTimeout(r, 50));

    // Verify file was written
    const filePath = path.join(tmpDir, ".virtucorp", "session-metadata.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe("dev");
    expect(entries[0].sessionKey).toBe("persist-session");
  });

  test("loads saved metadata on init so stale sessions survive restart", async () => {
    // Simulate a previous run: write metadata file directly
    const metaDir = path.join(tmpDir, ".virtucorp");
    await fs.mkdir(metaDir, { recursive: true });
    const oldEntry = [{
      role: "qa",
      createdAt: Date.now() - 120 * 60 * 1000, // 2 hours ago
      sessionKey: "old-qa-session",
    }];
    await fs.writeFile(
      path.join(metaDir, "session-metadata.json"),
      JSON.stringify(oldEntry),
    );

    // Init should load the old metadata
    await initPersistence(tmpDir);

    // getStaleSessions should find it (60 min threshold, session is 120 min old)
    const stale = getStaleSessions(60);
    const found = stale.find(s => s.sessionKey === "old-qa-session");
    expect(found).toBeDefined();
    expect(found?.role).toBe("qa");
    expect(found?.ageMinutes).toBeGreaterThan(60);
  });
});

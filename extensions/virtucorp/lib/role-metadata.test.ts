import { describe, test, expect, beforeEach } from "vitest";
import {
  setRoleMetadata,
  getRoleMetadata,
  clearRoleMetadata,
  setAssignedIssue,
  getAssignedIssue,
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

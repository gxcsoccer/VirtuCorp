import { describe, it, expect } from "vitest";
import { CircularBuffer } from "./browser-manager.js";

describe("CircularBuffer", () => {
  it("stores and retrieves items in order", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.getAll()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(3);
  });

  it("wraps around when capacity is exceeded", () => {
    const buf = new CircularBuffer<string>(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d"); // overwrites "a"
    expect(buf.getAll()).toEqual(["b", "c", "d"]);
    expect(buf.size).toBe(3);
  });

  it("handles multiple wraparounds", () => {
    const buf = new CircularBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    expect(buf.getAll()).toEqual([4, 5]);
  });

  it("returns empty array when no items pushed", () => {
    const buf = new CircularBuffer<number>(5);
    expect(buf.getAll()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it("clears properly", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.getAll()).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it("works with capacity of 1", () => {
    const buf = new CircularBuffer<string>(1);
    buf.push("a");
    expect(buf.getAll()).toEqual(["a"]);
    buf.push("b");
    expect(buf.getAll()).toEqual(["b"]);
    expect(buf.size).toBe(1);
  });
});

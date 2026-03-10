import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "extensions/virtucorp",
    include: ["**/*.test.ts"],
  },
});

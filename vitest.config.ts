import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests: everything except tests/integration/
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**"],
  },
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ponder", () => ({
  createConfig: <Config>(config: Config): Config => config,
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("ponder config", () => {
  it("does not filter token events when no indexed addresses are configured", async () => {
    const config = await loadPonderConfig({
      INDEXED_ADDRESSES: undefined,
      TOKEN_ADDRESS: "0x1000000000000000000000000000000000000000",
    });

    expect(config.contracts.ConfidentialToken).not.toHaveProperty("filter");
  });

  it("filters token events by address when indexed addresses are configured", async () => {
    const indexedAddress = "0x3000000000000000000000000000000000000000";
    const config = await loadPonderConfig({
      INDEXED_ADDRESSES: indexedAddress,
      TOKEN_ADDRESS: "0x1000000000000000000000000000000000000000",
    });

    expect(config.contracts.ConfidentialToken).toHaveProperty("filter");
  });
});

interface PonderTestConfig {
  contracts: {
    ConfidentialToken: { filter?: unknown };
  };
}

const loadPonderConfig = async (overrides: Record<string, string | undefined>): Promise<PonderTestConfig> => {
  process.env = {
    ...originalEnv,
    FHEVM_ACL_ADDRESS: "0x2000000000000000000000000000000000000000",
    INDEXER_ADDRESS: "0x4000000000000000000000000000000000000000",
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, value ?? ""])),
  };

  const module: { default: PonderTestConfig } = await import("../ponder.config.js");
  return module.default;
};

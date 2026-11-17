import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["tests/core/**/*.test.ts", "tests/store/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Stand-ins for the channel-ID Worker secrets `loadConfig` reads.
            // They live here, not in `wrangler.jsonc`, and must never move
            // there: anything in that file ships in the public repo and in
            // every deploy, and the real values are deploy-specific secrets.
            miniflare: {
              bindings: {
                REVIEW_CHANNEL_IDS: "100000000000000001",
                DIGEST_CHANNEL_ID: "100000000000000001",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      thresholds: {
        "src/core/**": { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  },
});

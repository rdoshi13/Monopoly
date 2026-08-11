import { defineConfig } from "vitest/config";

// Without a config here Vitest walks up to the retired root vite.config.ts,
// which is outside this workspace and fails to load.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": new URL("./src/cloudflare-workers.test-stub.ts", import.meta.url).pathname } },
  test: { include: ["src/**/*.test.ts"] },
});

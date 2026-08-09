import { defineConfig } from "vitest/config";

// Without a config here Vitest walks up to the retired root vite.config.ts,
// which is outside this workspace and fails to load.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });

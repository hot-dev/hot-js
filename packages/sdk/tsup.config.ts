import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "streaming/index": "src/streaming/index.ts",
    "agent/index": "src/agent/index.ts",
    "webhook/index": "src/webhook/index.ts",
    "proxy/index": "src/proxy/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
});

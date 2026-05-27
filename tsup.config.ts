import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  // Required so the published `dist/index.js` is `npx`-executable as the
  // package's `bin` entry. Pairs with `chmod +x dist/index.js` in the
  // build script.
  banner: {
    js: "#!/usr/bin/env node",
  },
});

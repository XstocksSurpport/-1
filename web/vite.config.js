import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** GitHub Pages 项目站路径：https://xstockssurpport.github.io/-1/ */
const GH_PAGES_BASE = "/-1/";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === "build" ? GH_PAGES_BASE : "/",
}));

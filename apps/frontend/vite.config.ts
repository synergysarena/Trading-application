import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Point @stock/shared at the TypeScript source instead of the compiled CJS dist.
    // This lets Rollup statically analyse all named exports (including zod schemas)
    // and avoids the __exportStar opacity issue that breaks the production build.
    alias: {
      "@stock/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  optimizeDeps: {
    exclude: ["@stock/shared"],
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://127.0.0.1:5001",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Dev: `npm run dev:web` (Vite on :5173) with the API server on :8787 (`npm run serve`).
// Build: web/dist, served by the Hono server.
const api = "http://localhost:8787";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { port: 5173, proxy: { "/api": api, "/mcp": api, "/health": api } },
});

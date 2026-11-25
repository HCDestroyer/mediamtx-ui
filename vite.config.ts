import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base "./" keeps asset URLs relative so the same build works from a static
// web server, from a sub-path and from the Capacitor WebView.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

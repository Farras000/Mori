import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/growtopia-cdn": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});

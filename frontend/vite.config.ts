import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In dev the backend runs separately on :8000.
      "/api": "http://localhost:8000",
    },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In dev the backend runs separately on :8000.
      "/api": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Spies and stubbed globals (notably fetch) are per-test, so one test
    // cannot leave a mocked backend behind for the next.
    restoreMocks: true,
    unstubGlobals: true,
    // Rendering a page and driving it takes far longer under jsdom than the
    // code being tested ever will, and slower on a shared CI runner than here.
    // A generous ceiling keeps that from reading as a failure; a genuinely
    // hung test still fails, just later.
    testTimeout: 20_000,
  },
});

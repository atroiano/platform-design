import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the API is whatever `make up` started. In a release the
// built files are served by the same process as the API, so there is no proxy.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8580", "/static": "http://localhost:8580" } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});

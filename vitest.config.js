// ABOUTME: Configures Picot's browser and build-script Vitest regression suites.
// ABOUTME: Keeps distribution-asset checks alongside frontend behavior tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.js"],
    include: [
      "public/**/*.test.js",
      "public/**/*.test.ts",
      "extensions/**/*.test.ts",
      "scripts/**/*.test.js",
    ],
    coverage: {
      provider: "istanbul",
      enabled: false,
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["public/**/*.js", "public/**/*.ts", "extensions/**/*.ts", "scripts/**/*.js"],
      exclude: [
        "**/*.test.{js,ts}",
        "extensions/dist/**",
        // These extension entry points run inside the Pi host; jsdom mocks do
        // not provide a meaningful measure of their production behavior.
        "extensions/pi-chat-src/**",
        // Node CLI scripts have contract tests but do not execute under jsdom.
        "scripts/**",
        "public/**/*-vendor-entry.js",
        "public/vendor/**",
      ],
    },
  },
});

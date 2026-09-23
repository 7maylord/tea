import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [
    { name: "phone-320", use: { viewport: { width: 320, height: 720 } } },
    { name: "phone-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 } } },
    { name: "desktop-1280", use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: "pnpm start --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

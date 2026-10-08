// 自動化端對端測試（tests/e2e）：以 Playwright 的 Electron 支援啟動建置好的 app（out/），
// Claude 換成測試控制的假 Claude（HARNESS_E2E_FAKE_CLAUDE=1）。執行：npm run test:e2e
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // 每個測試各自啟動一個 Electron 視窗；依序執行，避免視窗互搶焦點與 CPU
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  // 失敗時的截圖、trace 與 app.log 由 tests/e2e/fixtures.ts 附加（Electron 的頁面不受 use.screenshot 管理）
  outputDir: 'test-results'
})

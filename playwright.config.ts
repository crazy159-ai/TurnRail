import { defineConfig } from '@playwright/test'

/**
 * TurnRail 浏览器冒烟测试：
 * - 仅 Chromium（TurnRail 目标即 Chrome / Chromium 扩展）
 * - webServer 自动启动 scripts/serve-test-pages.mjs（127.0.0.1:8931）
 * - 测试页以 <script src="/dist/content.js"> 方式加载构建产物，
 *   chrome.storage 不可用时扩展自动降级 Live-only（缓存按钮禁用），属预期行为
 */
export default defineConfig({
  testDir: 'test/browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8931',
    viewport: { width: 1280, height: 720 }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node scripts/serve-test-pages.mjs',
    url: 'http://127.0.0.1:8931/test/fixture/index.html',
    reuseExistingServer: true,
    timeout: 15_000
  }
})

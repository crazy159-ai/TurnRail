import { test, expect } from '@playwright/test'
import { gotoWithDebug, waitForMarkers } from './helpers'

const MOCK = '/test/mock/index.html'

/**
 * v1.2.2 Storage Context Resilience 浏览器冒烟：
 * 在 content.js 加载前注入 chrome.storage.local 桩，模拟扩展重载后旧 content
 * script 的失效 context（调用以 "Extension context invalidated." reject）。
 * 核心契约：Cache failure ≠ Navigation failure；UI success == storage 操作真实成功。
 *
 * 注意：mock 页初始即处于会话 A 路由（history.replaceState），bootstrap 被动
 * 缓存读取在加载时就会发生；面板默认收起（visibility:hidden），需先 hover 轨道。
 */

/** 注入注定失败的 chrome.storage.local（succeedFirstGet=true 时首次 get 正常 miss，其余全 reject） */
async function injectFailingStorage(page: import('@playwright/test').Page, succeedFirstGet = false): Promise<void> {
  await page.addInitScript((succeedFirst) => {
    let gets = 0
    const boom = () => Promise.reject(new Error('Extension context invalidated.'))
    const stub = {
      get: (key: string) => {
        gets++
        if (succeedFirst && gets === 1) return Promise.resolve({ [key]: undefined })
        return boom()
      },
      set: () => boom(),
      remove: () => boom()
    }
    try {
      ;(globalThis as Record<string, unknown>).chrome = { storage: { local: stub } }
    } catch {
      Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: stub } } })
    }
  }, succeedFirstGet)
}

async function errCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as Record<string, number>).__tnErrCount ?? -1)
}

test('cache resilience: storage 全失败 → 被动读取后缓存控件禁用，导航完全不受影响', async ({ page }) => {
  await injectFailingStorage(page)
  await gotoWithDebug(page, MOCK)

  // mock 页初始即会话 A：bootstrap 被动缓存读取失败（context invalidated）
  // → 缓存子系统转为不可用，但 rail / 导航照常渲染（Cache failure ≠ Navigation failure）
  await waitForMarkers(page, 12)

  const cacheButton = page.locator('.tn-cache-btn')
  await expect(cacheButton).toBeDisabled()
  // 绝不因读取失败进入任何成功状态（☆ 保持，不出现 ★）
  await expect(cacheButton).toHaveAttribute('aria-pressed', 'false')

  // Live-only 导航完全正常：SPA 路由切换 + 增量 +1 轮照常工作
  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)
  await page.click('aside button[data-act="conv-a"]')
  await waitForMarkers(page, 12)
  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 13)

  // 失败的 storage 调用全部在 CacheStore 内部消化：无 error / unhandledrejection
  expect(await errCount(page)).toBe(0)
})

test('cache resilience: toggle 途中 storage 失败 → 不出现 ★ / “已缓存”假成功', async ({ page }) => {
  // 首次 get（bootstrap 被动读取）正常 miss，其后全部失败 → 复现“点击缓存按钮瞬间失效”
  await injectFailingStorage(page, true)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  const cacheButton = page.locator('.tn-cache-btn')
  await expect(cacheButton).toBeEnabled() // 被动读取成功（miss）→ 仍可用

  // 面板默认收起：hover 轨道展开后再点击 ☆
  await page.locator('.tn-rail').hover()
  await cacheButton.click()

  // toggle 内 get 失败 → 按钮禁用 + 提示刷新页面，绝不进入成功分支
  await expect(cacheButton).toBeDisabled()
  await expect(cacheButton).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.tn-status')).toHaveText(
    '扩展已重新加载，请刷新 ChatGPT 页面后恢复缓存功能'
  )

  // 导航不受影响
  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 13)
  expect(await errCount(page)).toBe(0)
})

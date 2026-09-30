import { test, expect, type Page } from '@playwright/test'
import { gotoWithDebug, waitForMarkers } from './helpers'

const MOCK = '/test/mock/index.html'

/**
 * v1.2.2 Storage Context Resilience + v1.2.3 Cache Runtime Lifecycle 浏览器冒烟：
 * 在 content.js 加载前注入 chrome.storage.local 桩，模拟扩展重载后旧 content
 * script 的失效 context（调用以 "Extension context invalidated." reject）。
 * 核心契约：
 * - Cache failure ≠ Navigation failure；UI success == storage 操作真实成功。
 * - expected invalidation 是 terminal 状态：首次失败后绝不再触碰 chrome.storage
 *   （storage call counter 断言），且不以 warning / error 级别记录 ——
 *   production 0 warn / 0 error；DEBUG 下最多一条 console.debug lifecycle。
 *
 * 注意：mock 页初始即处于会话 A 路由（history.replaceState），bootstrap 被动
 * 缓存读取在加载时就会发生；面板默认收起（visibility:hidden），需先 hover 轨道。
 */

interface StorageCalls {
  get: number
  set: number
  remove: number
}

/** 注入注定失败的 chrome.storage.local（succeedFirstGet=true 时首次 get 正常 miss，其余全 reject） */
async function injectFailingStorage(page: Page, succeedFirstGet = false): Promise<void> {
  await page.addInitScript((succeedFirst) => {
    let gets = 0
    const calls: StorageCalls = { get: 0, set: 0, remove: 0 }
    ;(globalThis as Record<string, unknown>).__tnStorageCalls = calls
    const boom = () => Promise.reject(new Error('Extension context invalidated.'))
    const stub = {
      get: (key: string) => {
        calls.get++
        gets++
        if (succeedFirst && gets === 1) return Promise.resolve({ [key]: undefined })
        return boom()
      },
      set: () => {
        calls.set++
        return boom()
      },
      remove: () => {
        calls.remove++
        return boom()
      }
    }
    try {
      ;(globalThis as Record<string, unknown>).chrome = { storage: { local: stub } }
    } catch {
      Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: stub } } })
    }
  }, succeedFirstGet)
}

async function storageCalls(page: Page): Promise<StorageCalls> {
  return page.evaluate(() => (globalThis as unknown as Record<string, StorageCalls>).__tnStorageCalls)
}

async function errCount(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as Record<string, number>).__tnErrCount ?? -1)
}

interface ConsoleEntry {
  type: string
  text: string
}

/** 按类型捕获页面全部 console 输出（warning / error / debug 分类断言用） */
function captureConsole(page: Page): ConsoleEntry[] {
  const entries: ConsoleEntry[] = []
  page.on('console', (msg) => entries.push({ type: msg.type(), text: msg.text() }))
  return entries
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

  // terminal circuit breaker：首次被动读取后 storage 不再被触碰（SPA 路由亦不恢复）
  const calls = await storageCalls(page)
  expect(calls.get).toBe(1)
  expect(calls.set).toBe(0)
  expect(calls.remove).toBe(0)

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

  // storage contract：被动读取 1 次 + toggle get 1 次后，terminal 短路（无 set / remove）
  const calls = await storageCalls(page)
  expect(calls.get).toBe(2)
  expect(calls.set).toBe(0)
  expect(calls.remove).toBe(0)
})

/**
 * v1.2.3 验收：production（无 tn-debug）下 expected invalidation 必须完全静默 ——
 * console.warn === 0、console.error === 0，被动失败不弹任何 UI 提示，
 * 导航 / Health 照常，且 SPA 路由切换不会重新触发 storage 调用。
 */
test('cache resilience: production 模式 invalidated → 0 warn / 0 error / 被动失败不弹提示', async ({ page }) => {
  await injectFailingStorage(page)
  const consoleEntries = captureConsole(page)
  await page.goto(MOCK) // 不设置 tn-debug：DEBUG 关闭

  await waitForMarkers(page, 12)

  const cacheButton = page.locator('.tn-cache-btn')
  await expect(cacheButton).toBeDisabled()
  await expect(cacheButton).toHaveAttribute('aria-pressed', 'false')
  // 被动 cache.read 失败：不得有任何 status 提示 / toast
  await expect(page.locator('.tn-status')).toHaveText('')

  // 导航 / SPA 路由 / Health 面板渲染照常
  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)
  await page.click('aside button[data-act="conv-a"]')
  await waitForMarkers(page, 12)
  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 13)

  // console contract（production）：0 warning / 0 error
  expect(consoleEntries.filter((entry) => entry.type === 'warning')).toHaveLength(0)
  expect(consoleEntries.filter((entry) => entry.type === 'error')).toHaveLength(0)

  // storage contract：首次被动读取后 terminal 短路
  const calls = await storageCalls(page)
  expect(calls.get).toBe(1)
  expect(calls.set).toBe(0)
  expect(calls.remove).toBe(0)

  expect(await errCount(page)).toBe(0)
})

/**
 * v1.2.3 验收：DEBUG（tn-debug=1）下 expected invalidation 也不得用 warning 级别 ——
 * 含 "extension context invalidated" 的输出只能是 console.debug 且最多一条。
 */
test('cache resilience: DEBUG 模式 invalidated → 0 warn，最多 1 条 console.debug lifecycle', async ({ page }) => {
  await injectFailingStorage(page)
  const consoleEntries = captureConsole(page)
  await gotoWithDebug(page, MOCK)

  await waitForMarkers(page, 12)
  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)
  await page.click('aside button[data-act="conv-a"]')
  await waitForMarkers(page, 12)

  const invalidated = consoleEntries.filter((entry) =>
    /extension context invalidated/i.test(entry.text)
  )
  expect(
    invalidated.filter((entry) => entry.type === 'warning' || entry.type === 'error')
  ).toHaveLength(0)
  expect(invalidated.filter((entry) => entry.type === 'debug')).toHaveLength(1)

  // terminal：SPA 路由切换不重新触发 storage
  const calls = await storageCalls(page)
  expect(calls.get).toBe(1)
  expect(calls.set).toBe(0)
  expect(calls.remove).toBe(0)

  expect(await errCount(page)).toBe(0)
})

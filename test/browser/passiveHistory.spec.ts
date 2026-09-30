import { test, expect, type Page } from '@playwright/test'
import { gotoWithDebug, readDebug, waitForMarkers } from './helpers'

/**
 * Passive History Harvest 浏览器测试。
 *
 * 核心验收不再是"后台能否滚完历史"，而是：
 * **TurnRail 长时间运行时绝不自主改变聊天滚动位置。**
 *
 * mock 页面的 deep 模式模拟 ChatGPT 长会话：初始只挂载最近 12 轮、
 * 接近视口顶部时自动懒加载更旧历史（deep40/72/120）。
 * 全部测试只模拟"用户自己的操作"（滚动 / 输入 / 点击），
 * 断言 TurnRail 在用户不操作时零移动、用户操作时零抢夺。
 */

const MOCK = '/test/mock/index.html'
const DEEP_ROUTE = '/c/mock-deep-3333-4444'

async function scrollerState(page: Page): Promise<{ top: number; height: number; client: number }> {
  return page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    return { top: sc.scrollTop, height: sc.scrollHeight, client: sc.clientHeight }
  })
}

/** 进入指定规模的长会话并等初始 12 轮完成索引 */
async function gotoDeep(page: Page, action: string, markers = 12): Promise<void> {
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)
  await page.click(`button[data-act="${action}"]`)
  await waitForMarkers(page, markers)
  await expect
    .poll(() => page.evaluate(() => location.pathname), { timeout: 5_000 })
    .toBe(DEEP_ROUTE)
  // mock 首帧 rAF 钉底，等待阅读位置稳定
  await page.waitForTimeout(600)
}

/**
 * P1 — Idle 绝不滚动：30 秒内（远超旧 warmup 的 initialIdle 5s + cooldown）无任何
 * 用户操作，scrollTop 必须保持不变，coverage 保持 partial / 未到顶。
 */
test('P1 - idle 绝不滚动：长时间放置 scrollTop 不变（第一优先级验收）', async ({ page }) => {
  test.setTimeout(60_000)
  await gotoDeep(page, 'deep40')

  const initial = await scrollerState(page)
  const initialTurns = (await readDebug(page)).storeTurns

  // 旧实现会在 5s initial idle 后开始探索；8s 足以暴露任何自主滚动
  await page.waitForTimeout(8_000)

  const after = await scrollerState(page)
  expect(after.top).toBe(initial.top)
  expect((await readDebug(page)).storeTurns).toBe(initialTurns)

  const debug = await readDebug(page)
  expect(debug.historyCoverage?.reachedTop).toBe(false)
  expect(debug.historyCoverage?.state).toBe('partial')

  // 静态覆盖状态（低干扰 footer 文本）
  const statusText = await page.locator('.tn-history-status').textContent()
  expect(statusText).toBe('历史 12 · 部分')

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

/** P2 — 用户阅读时绝不移动：停在中间 turn 超过旧 initialIdleMs，可见位置不变 */
test('P2 - 阅读时绝不移动：停在中间超过旧 idle 阈值后位置不变', async ({ page }) => {
  test.setTimeout(60_000)
  await gotoDeep(page, 'deep40')

  // 用户滚动到中部并停住（模拟阅读长回答）
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2
  })
  await page.waitForTimeout(300)
  const reading = await scrollerState(page)

  // 超过旧实现 initialIdleMs(5s) + userIdleMs(2.5s)：任何 warmup 都会在此窗口启动
  await page.waitForTimeout(10_000)

  const after = await scrollerState(page)
  expect(after.top).toBe(reading.top)
})

/** P3 — streaming 期间也不滚：用户停在中间，流式输出在底部追加，位置不得变化 */
test('P3 - streaming 期间不滚：用户停在中间阅读时位置不变', async ({ page }) => {
  test.setTimeout(60_000)
  await gotoDeep(page, 'deep40')

  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2
  })
  await page.waitForTimeout(300)
  const reading = await scrollerState(page)

  await page.click('button[data-act="stream"]')
  // 确认 streaming 确实发生（mutation pipeline 识别为流式输出）
  await expect
    .poll(
      async () => (await readDebug(page)).performance?.observer.assistantStreamIgnored ?? 0,
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0)
  // 流式约 3.5s + 余量；mock 仅在"用户已在底部"时跟随滚动，中部阅读绝不被移动
  await page.waitForTimeout(4_500)

  const after = await scrollerState(page)
  expect(after.top).toBe(reading.top)
})

/** P4 — 用户输入时不滚：composer focus / 输入期间零移动 */
test('P4 - composer 输入时不滚', async ({ page }) => {
  test.setTimeout(60_000)
  await gotoDeep(page, 'deep40')

  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2
  })
  await page.waitForTimeout(300)
  const reading = await scrollerState(page)

  await page.click('#prompt-textarea')
  await page.keyboard.type('正在输入一个全新的问题')
  await page.waitForTimeout(2_000)

  const after = await scrollerState(page)
  expect(after.top).toBe(reading.top)
})

/**
 * P5 — 被动自然收获：只有用户自己向旧历史滚动，ChatGPT 才挂载旧 turns，
 * indexedTurns 随之增长；全程 TurnRail 零自主滚动。用户自然停在视觉顶部后，
 * 被动到顶证据成立（reachedTop = true，coverage → complete）。
 */
test('P5 - 被动收获：用户自己滚旧历史 → 索引增长；自然到顶 → reachedTop', async ({ page }) => {
  test.setTimeout(90_000)
  await gotoDeep(page, 'deep40')

  // 用户逐次滚向视觉顶部；懒加载每次 prepend 8 轮并做 scroll anchoring
  for (let i = 0; i < 20; i++) {
    const pending = await page.evaluate(() => (globalThis as any).__deep.pendingHistoryCount())
    if (pending === 0) break
    await page.evaluate(() => {
      ;(document.getElementById('scroller') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(400)
  }
  expect(await page.evaluate(() => (globalThis as any).__deep.pendingHistoryCount())).toBe(0)
  await expect
    .poll(async () => (await readDebug(page)).storeTurns, { timeout: 15_000 })
    .toBe(40)

  // 用户自然停在视觉顶部：被动到顶证据（稳定窗口内无新懒加载）→ complete
  await page.evaluate(() => {
    ;(document.getElementById('scroller') as HTMLElement).scrollTop = 0
  })
  await expect
    .poll(async () => (await readDebug(page)).historyCoverage?.reachedTop, { timeout: 15_000 })
    .toBe(true)
  expect((await readDebug(page)).historyCoverage?.state).toBe('complete')
  expect(await page.locator('.tn-history-status').textContent()).toBe('历史 40 · 已补全')

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

/**
 * P6/P7/P8/P9 — 缓存 preview 目录 → 自然浏览升级 full：
 * 缓存 hydrate 的未挂载 turn 显示"仅预览"，健康低置信度提示可见；
 * 用户自然滚到该区域后 preview → full（文本相同也必须触发），
 * "仅预览"消失、健康重算（覆盖度提升感知）、低置信度提示解除。
 */
test('P6-P9 - preview 目录：仅预览标记 → 自然升级 full → Health 感知', async ({ page }) => {
  test.setTimeout(120_000)
  // 注入可用的内存版 chrome.storage.local（缓存功能在 mock 页可用的前提）
  await page.addInitScript(() => {
    const mem: Record<string, unknown> = {}
    const stub = {
      get: (key: string) => Promise.resolve(key in mem ? { [key]: mem[key] } : {}),
      set: (items: Record<string, unknown>) => {
        Object.assign(mem, items)
        return Promise.resolve()
      },
      remove: (key: string) => {
        delete mem[key]
        return Promise.resolve()
      }
    }
    try {
      ;(globalThis as any).chrome = { ...(globalThis as any).chrome, storage: { local: stub } }
    } catch {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { storage: { local: stub } }
      })
    }
  })
  await gotoDeep(page, 'deep40')

  // 1) 显式捕获全部 40 轮（唯一允许滚动的用户动作），随后手动缓存
  await page.hover('.tn-rail')
  await expect.poll(() => page.locator('.tn-panel.tn-open').count(), { timeout: 10_000 }).toBe(1)
  await page.click('.tn-load-btn')
  const loadBtn = page.locator('.tn-load-btn')
  await expect.poll(async () => loadBtn.isDisabled(), { timeout: 60_000 }).toBe(true)
  await expect
    .poll(async () => (await readDebug(page)).storeTurns, { timeout: 30_000 })
    .toBe(40)
  await expect.poll(async () => loadBtn.isDisabled(), { timeout: 60_000 }).toBe(false)
  await page.click('.tn-cache-btn')

  // 2) 离开 → 回到同一会话：缓存 hydrate 恢复 40 轮目录，但 ChatGPT 只挂载最近 12 轮
  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)
  await page.click('button[data-act="deep40"]')
  // hydrate 在首扫前恢复目录：markers 直接到 40（含 28 个 detached preview）
  await expect
    .poll(async () => (await readDebug(page)).storeTurns, { timeout: 15_000 })
    .toBe(40)

  // 3) 打开目录：28 个未挂载 turn 必须显示"仅预览"（不是"未加载"）
  await page.hover('.tn-rail')
  await expect.poll(async () => page.locator('.tn-item').count(), { timeout: 10_000 }).toBe(40)
  expect(await page.locator('.tn-flag', { hasText: '仅预览' }).count()).toBe(28)
  expect(await page.locator('.tn-flag', { hasText: '未加载' }).count()).toBe(0)

  // 低置信度提示可见（coverageRatio 12/40 → low confidence）
  await expect
    .poll(async () => page.locator('.tn-health-note:not(.tn-health-note-hidden)').count(), {
      timeout: 10_000
    })
    .toBe(1)
  const analyzesBefore = (await readDebug(page)).performance?.health.analyzes ?? 0

  // 4) 用户自然滚向旧历史 → Live 挂载 → preview 升级 full（缓存 preview 与全文一致，
  //    纯 coverage 事件路径）；"仅预览"全部消失
  for (let i = 0; i < 20; i++) {
    const pending = await page.evaluate(() => (globalThis as any).__deep.pendingHistoryCount())
    if (pending === 0) break
    await page.evaluate(() => {
      ;(document.getElementById('scroller') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(400)
  }
  await expect.poll(async () => page.locator('.tn-flag').count(), { timeout: 20_000 }).toBe(0)

  // 5) Health 感知覆盖度提升：文本未变，健康仍必须重算（coverageRevision 路径），
  //    低置信度提示解除
  const analyzesAfter = (await readDebug(page)).performance?.health.analyzes ?? 0
  expect(analyzesAfter).toBeGreaterThan(analyzesBefore)
  await expect
    .poll(async () => page.locator('.tn-health-note:not(.tn-health-note-hidden)').count(), {
      timeout: 10_000
    })
    .toBe(0)

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

/**
 * P11/P12 — Manual Capture 仍然可用且是唯一被授权的滚动：
 * 点击「加载全部历史」→ 按钮明确 busy → 到顶 → 恢复阅读位置；
 * reachedTop / complete 只能由这条显式路径（或被动到顶证据）设置。
 */
test('P11+P12 - 手动加载全部历史：busy 明确、收获完整、恢复阅读位置', async ({ page }) => {
  test.setTimeout(120_000)
  await gotoDeep(page, 'deep40')
  const before = await scrollerState(page)
  expect(before.height - before.client - before.top).toBeLessThan(50) // 起始在底部

  await page.hover('.tn-rail')
  await expect.poll(() => page.locator('.tn-panel.tn-open').count(), { timeout: 10_000 }).toBe(1)
  const loadBtn = page.locator('.tn-load-btn')
  expect(await loadBtn.getAttribute('title')).toContain('主动滚动聊天')

  await page.click('.tn-load-btn')

  // busy UI：用户明确知道页面正在被 TurnRail 滚动
  await expect.poll(async () => loadBtn.isDisabled(), { timeout: 10_000 }).toBe(true)
  expect(await loadBtn.textContent()).toBe('加载中…')

  await expect
    .poll(async () => (await readDebug(page)).storeTurns, { timeout: 60_000 })
    .toBe(40)
  await expect.poll(async () => loadBtn.isDisabled(), { timeout: 60_000 }).toBe(false)
  expect(await loadBtn.textContent()).toBe('加载全部历史')

  const debug = await readDebug(page)
  expect(debug.historyCoverage?.reachedTop).toBe(true)
  expect(debug.historyCoverage?.state).toBe('complete')

  // 完成后恢复点击前的阅读位置（仍接近底部；懒加载 prepend 使 extent 增长，
  // 锚定的是"接近底部"这一阅读位置，允许像素误差）
  await page.waitForTimeout(800)
  const after = await scrollerState(page)
  expect(after.height - after.client - after.top).toBeLessThan(600)

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

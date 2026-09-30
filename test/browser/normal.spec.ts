import { test, expect } from '@playwright/test'
import { gotoWithDebug, readDebug, waitForMarkers, expectPoll, type TnHooks } from './helpers'

const MOCK = '/test/mock/index.html'

test.beforeEach(async ({ page }) => {
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)
})

test('normal mock: 初始索引 + 新增 1 轮增量更新', async ({ page }) => {
  const base = await readDebug(page)
  expect(base.storeTurns).toBe(12)
  expect(base.markers).toBe(12)

  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 13)

  const after = await readDebug(page)
  expect(after.storeTurns).toBe(13)
  expect(after.markers).toBe(13)
})

test('normal mock: SPA 会话 A → B → A 不串数据、marker 不重复', async ({ page }) => {
  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)

  let turns: TnHooks['store']['turns'] = await page.evaluate(
    () => JSON.parse(JSON.stringify((globalThis as any).__tn.store.turns))
  )
  expect(turns).toHaveLength(8)
  expect(new Set(turns.map((turn) => turn.id)).size).toBe(8)
  expect(turns[0]!.title).toContain('Q101')

  await page.click('aside button[data-act="conv-a"]')
  await waitForMarkers(page, 12)

  turns = await page.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__tn.store.turns)))
  expect(turns).toHaveLength(12)
  expect(new Set(turns.map((turn) => turn.id)).size).toBe(12)
  expect(turns[0]!.title).toContain('Q1:')

  const debug = await readDebug(page)
  expect(debug.markers).toBe(12)
  expect(debug.turnRoots).toBe(12)
})

test('normal mock: assistant streaming 无错误、无 fallback full-scan 回归', async ({ page }) => {
  const base = await readDebug(page)
  const baseFallbackScans = base.performance?.indexer.fallbackFullScans ?? 0

  await page.click('button[data-act="stream"]')
  // 流式 turn 首挂载必须进入索引（marker +1），不能被 streaming 过滤误伤
  await waitForMarkers(page, 13)

  // streaming mutation 被分类忽略（不触发索引，只调度 geometry refresh）
  const ignored = await pollUntil(async () => {
    const dbg = await readDebug(page)
    return dbg.performance?.observer.assistantStreamIgnored ?? 0
  }, (value) => value > 0, 15_000)
  expect(ignored).toBeGreaterThan(0)

  // 等流式结束（最后一条 assistant p 的文本长度到达模拟文本全长 78）
  await expectPoll(
    async () =>
      page.evaluate(() => {
        const ps = [...document.querySelectorAll('[data-markdown-text-style="assistant-message"] p')]
        return ps[ps.length - 1]?.textContent?.length ?? 0
      }),
    78,
    20_000
  )

  const end = await readDebug(page)
  expect(end.storeTurns).toBe(13)
  expect(end.markers).toBe(13)
  // 性能合同：streaming 不允许引发 fallback full-scan 增长（不写死精确 mutation 数）
  expect((end.performance?.indexer.fallbackFullScans ?? 0) - baseFallbackScans).toBe(0)

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
  const hostConnected = await page.evaluate(() => document.getElementById('turnrail-host') !== null)
  expect(hostConnected).toBe(true)
})

test('normal mock: 虚拟化卸载后 metadata 保留、已收获的 detached 项不显示"未加载"', async ({ page }) => {
  await page.click('button[data-act="add150-dup"]')
  await waitForMarkers(page, 162, 30_000)

  await page.click('button[data-act="virt-on"]')
  // 触发一次滚动使虚拟化窗口落在中部，卸载窗口外 turn
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2
  })
  await page.waitForTimeout(700)

  // DOM turn 被卸载，但 Store metadata 仍保留
  const debug = await readDebug(page)
  expect(debug.storeTurns).toBe(162)
  expect(debug.turnRoots).toBeLessThan(162)
  expect(debug.markers).toBe(162)

  // 打开 outline 面板：所有 item 都曾被完整解析（full），卸载 ≠ 未收获，
  // 规格规格 #58 U2：full + detached 不得显示"未加载"
  await page.hover('.tn-rail')
  await expect.poll(async () => page.locator('.tn-item').count(), { timeout: 10_000 }).toBeGreaterThan(0)
  expect(await page.locator('.tn-flag').count()).toBe(0)
})

test('normal mock: 点击未挂载 turn 触发 recover 并成功跳转', async ({ page }) => {
  await page.click('button[data-act="add150-dup"]')
  await waitForMarkers(page, 162, 30_000)
  await page.click('button[data-act="virt-on"]')
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2
  })
  await page.waitForTimeout(700)

  // 选一个当前未挂载的 turn（Store 有 metadata、DOM 未 mounted）
  const target = await page.evaluate(() => {
    const turns = (globalThis as any).__tn.store.turns as { id: string; index: number }[]
    const unmounted = turns.filter((turn) => {
      const el = (globalThis as any).__tn.store.getTurn(turn.id)?.user?.element
      return !el || !el.isConnected
    })
    return unmounted[Math.floor(unmounted.length / 2)]?.id ?? null
  })
  expect(target).not.toBeNull()

  // 真实点击该 turn 的 rail marker → jumpToTurn 失败 → recoverAndJump 受控滚动查找
  await page.click(`.tn-marker[data-turn-id="${target}"]`)

  // recover 合同（规格 #36）：受控滚动找到目标 turn（found=true 即 recover succeeded）。
  // 不断言 active === 目标：recover 路径的 active 由 scroll-spy 阅读带在动画结束后
  // 重新判定，且虚拟化重挂载可能把 active 移到相邻 turn，均属正常行为。
  await expectPoll(
    async () =>
      page.evaluate(() => ((globalThis as any).__tn.recoverLog() as string[]).some((line) => line.includes('found=true'))),
    true,
    40_000
  ).catch(async () => {
    const log = await page.evaluate(() => (globalThis as any).__tn.recoverLog() as string[])
    expect(log.some((line) => line.includes('found=true')), `recoverLog=${JSON.stringify(log)}`).toBe(true)
  })

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

/** 轮询直到 predicate 满足，返回最终值 */
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout: number
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: T = await fn()
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 300))
    last = await fn()
  }
  return last
}

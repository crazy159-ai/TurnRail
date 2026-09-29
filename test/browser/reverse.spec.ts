import { test, expect } from '@playwright/test'
import { gotoWithDebug, readDebug, readActiveTurnId, waitForMarkers, expectPoll } from './helpers'

const REVERSE = '/test/mock/reverse.html'

test.beforeEach(async ({ page }) => {
  await gotoWithDebug(page, REVERSE)
  await page.click('button[data-act="add60"]')
  await waitForMarkers(page, 72, 20_000)
})

test('reverse mock: column-reverse 负 scrollTop 几何契约', async ({ page }) => {
  const debug = await readDebug(page)
  // 滚动容器必须被识别为反向坐标系
  expect(debug.flexDirection).toBe('column-reverse')
  expect(debug.scrollExtent).toBeGreaterThan(0)
  // column-reverse：scrollTop ∈ [-extent, 0]；负值是合法值，绝不允许被 clamp 到 0
  expect(debug.scrollMin).toBeLessThan(0)
  expect(debug.scrollMax).toBe(0)

  const raw = await page.evaluate(() => (document.getElementById('scroller') as HTMLElement).scrollTop)
  expect(raw).toBeLessThanOrEqual(0)
})

test('reverse mock: jump 回归 Q72 → Q2（后期 → 早期）页面真实滚动且命中目标', async ({ page }) => {
  const turns = await page.evaluate(() =>
    JSON.parse(JSON.stringify((globalThis as any).__tn.store.turns))
  ) as { id: string }[]
  expect(turns).toHaveLength(72)

  const scrollBefore = await page.evaluate(
    () => (document.getElementById('scroller') as HTMLElement).scrollTop
  )

  // 点击早期问题 Q2 的 marker（当前视口在最新端）
  await page.click(`.tn-marker[data-turn-id="${turns[1]!.id}"]`)

  // 页面确实发生滚动（450ms 缓动动画期间持续轮询，负值 = 向历史方向）
  await expectPoll(
    async () => page.evaluate(() => (document.getElementById('scroller') as HTMLElement).scrollTop < -1),
    true,
    10_000
  )
  // active turn 命中目标（阅读带语义：短 turn 场景下允许落在相邻一档）
  await expectPoll(
    async () => {
      const active = await readActiveTurnId(page)
      const idx = turns.findIndex((turn) => turn.id === active)
      return idx >= 1 && idx <= 2
    },
    true,
    15_000
  )

  const scrollAfter = await page.evaluate(
    () => (document.getElementById('scroller') as HTMLElement).scrollTop
  )
  expect(scrollAfter).not.toBe(scrollBefore)
  await assertTargetNearViewportTop(page, turns[1]!.id)
  // 负 scrollTop 保持合法（未因跳转被 clamp 回 0）
  expect(scrollAfter).toBeLessThanOrEqual(-1)
})

test('reverse mock: jump 回归 Q2 → Q70（早期 → 后期）', async ({ page }) => {
  const turns = await page.evaluate(() =>
    JSON.parse(JSON.stringify((globalThis as any).__tn.store.turns))
  ) as { id: string }[]

  await page.click(`.tn-marker[data-turn-id="${turns[1]!.id}"]`)
  await expectPoll(
    async () => {
      const active = await readActiveTurnId(page)
      const idx = turns.findIndex((turn) => turn.id === active)
      return idx >= 1 && idx <= 2
    },
    true,
    15_000
  )

  await page.click(`.tn-marker[data-turn-id="${turns[69]!.id}"]`)
  await expectPoll(
    async () => {
      const active = await readActiveTurnId(page)
      const idx = turns.findIndex((turn) => turn.id === active)
      return idx >= 68 && idx <= 70
    },
    true,
    15_000
  )
  await assertTargetNearViewportTop(page, turns[69]!.id)
})

test('reverse mock: 视觉顶部 / 底部边界 active 正确，负 scrollTop 不被破坏', async ({ page }) => {
  const turns = await page.evaluate(() =>
    JSON.parse(JSON.stringify((globalThis as any).__tn.store.turns))
  ) as { id: string }[]

  // 视觉顶部（最旧一端）：scrollTop = min（负值）
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = -sc.scrollHeight
  })
  await expectPoll(async () => readActiveTurnId(page), turns[0]!.id, 10_000)

  const atTop = await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    return { scrollTop: sc.scrollTop, min: (globalThis as any).__tnDebug.scrollMin as number }
  })
  // 负 scrollTop 被完整保留（≈ min），绝不允许出现 Math.max(0, scrollTop) 之类的回归
  expect(atTop.scrollTop).toBeLessThan(-1)
  expect(Math.abs(atTop.scrollTop - atTop.min)).toBeLessThanOrEqual(2)
  expect(atTop.min).toBeLessThan(0)

  // 视觉底部（最新一端）：scrollTop = 0
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = sc.scrollHeight
  })
  await expectPoll(async () => readActiveTurnId(page), turns[turns.length - 1]!.id, 10_000)

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

/** 目标 turn 的 user 单元应接近视口阅读位置（容器顶部 40% 内）；先等 450ms 缓动动画结束 */
async function assertTargetNearViewportTop(page: import('@playwright/test').Page, turnId: string): Promise<void> {
  await page.waitForTimeout(700)
  const ratio = await page.evaluate((id) => {
    const sc = document.getElementById('scroller') as HTMLElement
    const turn = (globalThis as any).__tn.store.getTurn(id)
    const target = turn?.user?.element ?? turn?.root
    if (!target || !target.isConnected) return null
    const containerRect = sc.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    return (targetRect.top - containerRect.top) / Math.max(1, sc.clientHeight)
  }, turnId)
  expect(ratio).not.toBeNull()
  expect(ratio as number).toBeGreaterThanOrEqual(-0.05)
  expect(ratio as number).toBeLessThanOrEqual(0.4)
}

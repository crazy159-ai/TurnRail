import { test, expect } from '@playwright/test'
import { gotoWithDebug, waitForMarkers } from './helpers'

const MOCK = '/test/mock/index.html'

/**
 * v1.2.x Chat Health Check 浏览器冒烟：
 * mock 页初始即有 12 轮 user turn → 健康卡应显示；追加轮次 / assistant
 * streaming 期间不得产生 pageerror（streaming 尤其不得反复触发健康重算路径）。
 * 面板默认收起（visibility:hidden），可见性断言前需 hover 轨道展开。
 */

test.beforeEach(async ({ page }) => {
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)
})

test('health: 健康卡可见，分数 0-100 且注明本地启发式估算', async ({ page }) => {
  await page.locator('.tn-rail').hover() // 展开面板

  const card = page.locator('.tn-health')
  await expect(card).toBeVisible()
  await expect(card.locator('.tn-health-score')).toHaveText(/\d+/)

  const score = Number(await card.locator('.tn-health-score').textContent())
  expect(score).toBeGreaterThanOrEqual(0)
  expect(score).toBeLessThanOrEqual(100)

  await expect(card).toHaveAttribute('aria-live', 'polite')
  await expect(card.locator('.tn-health-note')).toContainText('本地启发式评估')
  const label = await card.getAttribute('aria-label')
  expect(label).toContain('对话健康度')
  expect(label).toContain(String(score))
})

test('health: 追加轮次 + assistant streaming 期间无 pageerror，健康卡输出合法', async ({ page }) => {
  const card = page.locator('.tn-health')
  const before = Number(await card.locator('.tn-health-score').textContent())
  expect(before).toBeGreaterThanOrEqual(0)

  // 追加 1 轮（structure 事件 → 允许重算一次）并保持无错误
  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 13)
  await expect(card.locator('.tn-health-score')).toHaveText(/\d+/)

  // assistant streaming：structure 只在轮挂载时变化一次，文本批不得触发健康重算路径
  await page.click('button[data-act="stream"]')
  await waitForMarkers(page, 14)

  const after = Number(await card.locator('.tn-health-score').textContent())
  expect(after).toBeGreaterThanOrEqual(0)
  expect(after).toBeLessThanOrEqual(100)

  const errCount = await page.evaluate(
    () => (globalThis as unknown as Record<string, number>).__tnErrCount ?? -1
  )
  expect(errCount).toBe(0)
})

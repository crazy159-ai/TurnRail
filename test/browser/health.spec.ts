import { test, expect } from '@playwright/test'
import { gotoWithDebug, waitForMarkers } from './helpers'

const MOCK = '/test/mock/index.html'

/**
 * Chat Health 浏览器冒烟（第二阶段）：
 * - 健康卡展示合同（分数 0-100 / 估算说明在 tooltip / 降噪分层）；
 * - streaming 计数合同：assistant 流式期间健康分析最多 +1（新 turn 挂载的
 *   structure 事件），文本批必须为 0（perf.health.analyzes）。
 * 面板默认收起，可见性断言前需 hover 轨道展开。
 */

test.beforeEach(async ({ page }) => {
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)
})

test('health: 健康卡可见，healthy 态单行降噪，估算说明在 tooltip', async ({ page }) => {
  await page.locator('.tn-rail').hover() // 展开面板

  const card = page.locator('.tn-health')
  await expect(card).toBeVisible()
  await expect(card.locator('.tn-health-score')).toHaveText(/\d+/)

  const score = Number(await card.locator('.tn-health-score').textContent())
  expect(score).toBeGreaterThanOrEqual(0)
  expect(score).toBeLessThanOrEqual(100)

  // mock 初始 12 轮中性问答 → 应为 healthy：单行降噪（无建议行 / 无原因行）
  const datasetLevel = await card.getAttribute('data-level')
  expect(datasetLevel).toBe('healthy')
  await expect(card.locator('.tn-health-message')).toHaveText('')
  await expect(card.locator('.tn-health-reasons')).toHaveText('')
  // 全 live → 无低置信度徽章、无覆盖提示
  await expect(card.locator('.tn-health-conf')).toBeHidden()
  await expect(card.locator('.tn-health-note')).toHaveText('')

  // 估算性质说明移至 tooltip
  const tooltip = await card.getAttribute('title')
  expect(tooltip).toContain('本地启发式评估')
  expect(tooltip).toContain('不代表 ChatGPT 实际剩余上下文')

  await expect(card).toHaveAttribute('aria-live', 'polite')
  const label = await card.getAttribute('aria-label')
  expect(label).toContain('对话健康度')
})

test('health: 追加轮次 + assistant streaming 期间无 pageerror，输出保持合法', async ({ page }) => {
  const card = page.locator('.tn-health')

  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 13)
  await expect(card.locator('.tn-health-score')).toHaveText(/\d+/)

  await page.click('button[data-act="stream"]')
  await waitForMarkers(page, 14)

  const score = Number(await card.locator('.tn-health-score').textContent())
  expect(score).toBeGreaterThanOrEqual(0)
  expect(score).toBeLessThanOrEqual(100)

  const errCount = await page.evaluate(
    () => (globalThis as unknown as Record<string, number>).__tnErrCount ?? -1
  )
  expect(errCount).toBe(0)
})

/** P2-1 合同：流式文本批不得触发健康重算（perf.health.analyzes 增量 ≤ 1） */
test('health: assistant streaming 期间分析计数最多 +1', async ({ page }) => {
  const readAnalyzes = () =>
    page.evaluate(() => {
      const perf = (globalThis as unknown as Record<string, any>).__tnDebug?.performance
      return typeof perf?.health?.analyzes === 'number' ? perf.health.analyzes : -1
    })

  const before = await readAnalyzes()
  expect(before).toBeGreaterThanOrEqual(0)

  await page.click('button[data-act="stream"]')
  await waitForMarkers(page, 13)
  // 等待多个流式文本批落地（若实现回归为每批重算，这里会显著超过 1）
  await page.waitForTimeout(2500)

  const after = await readAnalyzes()
  expect(after - before).toBeLessThanOrEqual(1)
})

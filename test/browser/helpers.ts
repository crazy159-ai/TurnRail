import { expect, type Page } from '@playwright/test'

/** __tnDebug / __tn 调试钩子暴露的字段（全部为元数据，无聊天正文） */
export interface TnDebug {
  storeTurns: number
  markers: number
  turnRoots: number
  userUnits: number
  assistantUnits: number
  providerMode: string
  historyWarmup?: {
    state: string
    discoveredTurns: number
    fullUserTurns: number
    previewUserTurns: number
    batches: number
    steps: number
    reachedTop: boolean
    pausedReason: string | null
  }
  performance: {
    indexer: { fullScans: number; incrementalScans: number; fallbackFullScans: number; skippedTurns: number }
    observer: { assistantStreamIgnored: number; mutationRecords: number }
    historyWarmup?: {
      batches: number
      steps: number
      productiveBatches: number
      emptyBatches: number
      pauses: number
      maxBatchMs: number
      turnsDiscovered: number
    }
  } | null
  cache: Record<string, unknown>
  flexDirection: string | null
  scrollTop: number | null
  scrollExtent: number | null
  scrollMin: number | null
  scrollMax: number | null
  atVisualTop: boolean | null
  atVisualBottom: boolean | null
}

export interface TnStoreTurn {
  id: string
  index: number
  title: string
}

export interface TnHooks {
  store: {
    turns: TnStoreTurn[]
    activeTurnId?: string
    getTurn(id: string): TnStoreTurn | undefined
  }
  recoverLog(): string[]
}

/** 在 content.js 加载前开启 tn-debug（DEBUG 于模块求值时读取 localStorage） */
export async function gotoWithDebug(page: Page, url: string): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tn-debug', '1')
    } catch {
      /* 忽略 */
    }
  })
  await page.goto(url)
}

export async function readDebug(page: Page): Promise<TnDebug> {
  return page.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__tnDebug))) as Promise<TnDebug>
}

export async function readTn(page: Page): Promise<TnHooks> {
  return page.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__tn))) as Promise<TnHooks>
}

export async function readActiveTurnId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (globalThis as any).__tn?.store?.activeTurnId) as Promise<string | undefined>
}

/** 等待 rail marker 数达到期望（marker 全部位于 Shadow DOM 内） */
export async function waitForMarkers(page: Page, count: number, timeout = 10_000): Promise<void> {
  await expect.poll(() => page.locator('.tn-marker').count(), { timeout }).toBe(count)
}

/** expect.poll 薄封装 */
export async function expectPoll(
  fn: () => Promise<unknown>,
  expected: unknown,
  timeout = 10_000
): Promise<void> {
  await expect.poll(fn, { timeout }).toBe(expected)
}

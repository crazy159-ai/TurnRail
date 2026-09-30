import { test, expect, type Page } from '@playwright/test'
import { gotoWithDebug, readDebug, waitForMarkers } from './helpers'

/**
 * Background History Warmup 浏览器测试（规格 #60-#76）。
 * mock 页面的 deep 模式模拟 ChatGPT 长会话：初始只挂载最近 12 轮、
 * 接近视口顶部时自动懒加载更旧历史、（deep120）按 ±40 窗口虚拟化卸载。
 * warmup 真实时序运行（initialIdle 5s / productive cooldown 2.5s），
 * 相关用例用 test.setTimeout 放宽超时。
 */

const MOCK = '/test/mock/index.html'
const DEEP_ROUTE = '/c/mock-deep-3333-4444'

interface DeepState {
  pendingHistoryCount(): number
  turnSeqCount(): number
  mountedCount(): number
}

async function readDeep(page: Page): Promise<DeepState> {
  return page.evaluate(() => ({
    pendingHistoryCount: (window as any).__deep.pendingHistoryCount(),
    turnSeqCount: (window as any).__deep.turnSeqCount(),
    mountedCount: (window as any).__deep.mountedCount()
  }))
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
}

async function warmupSteps(page: Page): Promise<number> {
  const debug = await readDebug(page)
  return debug.historyWarmup?.steps ?? 0
}

test('B1 - 自动逐步加载：懒加载历史被 warmup 逐步收获到 Store', async ({ page }) => {
  test.setTimeout(420_000)
  await gotoDeep(page, 'deep120')

  // 初始只有 12 轮进入 Store；warmup 开启后 indexed turns 必须持续增长
  await expect
    .poll(async () => (await readDebug(page)).storeTurns, { timeout: 120_000 })
    .toBeGreaterThan(24)

  const mid = await readDebug(page)
  expect(mid.historyWarmup?.batches ?? 0).toBeGreaterThan(0)
  expect(mid.historyWarmup?.steps ?? 0).toBeGreaterThan(0)

  // 懒加载全部耗尽 + Store 收获完全部 120 轮（保守调度下全程约 3~4 分钟）
  await expect
    .poll(async () => (await readDeep(page)).pendingHistoryCount, { timeout: 360_000 })
    .toBe(0)
  await expect
    .poll(async () => (await readDebug(page)).storeTurns, { timeout: 120_000 })
    .toBe(120)

  const end = await readDebug(page)
  expect(end.historyWarmup?.discoveredTurns ?? 0).toBeGreaterThan(100)

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

test('B2 - 用户滚动立即暂停 warmup，空闲后恢复', async ({ page }) => {
  test.setTimeout(120_000)
  await gotoDeep(page, 'deep72')

  // 等 warmup 进入活跃状态
  await expect.poll(async () => warmupSteps(page), { timeout: 60_000 }).toBeGreaterThan(0)

  // 用户滚动（wheel）
  await page.evaluate(() => {
    document
      .getElementById('scroller')!
      .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
  })
  const stepsAtWheel = await warmupSteps(page)

  // 暂停期内 steps 不得增长（检查窗口 < userIdleMs 2.5s）
  await page.waitForTimeout(1800)
  const stepsDuringPause = await warmupSteps(page)
  expect(stepsDuringPause).toBe(stepsAtWheel)

  const paused = await readDebug(page)
  expect(paused.historyWarmup?.state).toBe('paused')
  expect(paused.historyWarmup?.pausedReason).toBe('user-active')

  // 空闲超过 userIdleMs + recheck → 恢复
  await expect
    .poll(async () => warmupSteps(page), { timeout: 30_000 })
    .toBeGreaterThan(stepsDuringPause)
})

test('B3 - composer 输入暂停 warmup', async ({ page }) => {
  test.setTimeout(120_000)
  await gotoDeep(page, 'deep72')

  await expect.poll(async () => warmupSteps(page), { timeout: 60_000 }).toBeGreaterThan(0)

  await page.click('#prompt-textarea')
  await page.keyboard.type('正在输入新问题')
  const stepsAtInput = await warmupSteps(page)

  await page.waitForTimeout(1800)
  const debug = await readDebug(page)
  expect(debug.historyWarmup?.state).toBe('paused')
  expect(debug.historyWarmup?.pausedReason).toBe('user-active')
  expect(await warmupSteps(page)).toBe(stepsAtInput)
})

test('B4+B5 - assistant streaming 期间暂停，静默后恢复', async ({ page }) => {
  test.setTimeout(150_000)
  await gotoDeep(page, 'deep72')

  await expect.poll(async () => warmupSteps(page), { timeout: 60_000 }).toBeGreaterThan(0)

  await page.click('button[data-act="stream"]')
  // 流式开始（mutation pipeline 上报 assistant-streaming）
  await expect
    .poll(
      async () => (await readDebug(page)).performance?.observer.assistantStreamIgnored ?? 0,
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0)

  const stepsAtStream = await warmupSteps(page)
  // 流式持续约 3s：期间 warmup 不得滚动
  await page.waitForTimeout(1500)
  expect(await warmupSteps(page)).toBe(stepsAtStream)
  const during = await readDebug(page)
  expect(['paused', 'warming', 'scheduled']).toContain(during.historyWarmup?.state ?? '')

  // 等流式结束
  await expectPollLastAssistantText(page, 78, 30_000)
  // streamingQuietMs 1.8s + recheck → 恢复
  await expect.poll(async () => warmupSteps(page), { timeout: 30_000 }).toBeGreaterThan(stepsAtStream)
})

/** 等最后一条 assistant 文本长度到达模拟全文长度 */
async function expectPollLastAssistantText(page: Page, length: number, timeout: number): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const ps = [
            ...document.querySelectorAll('[data-markdown-text-style="assistant-message"] p')
          ]
          return ps[ps.length - 1]?.textContent?.length ?? 0
        }),
      { timeout }
    )
    .toBe(length)
}

test('B6 - 阅读位置稳定：warmup 完成后恢复同一阅读锚点', async ({ page }) => {
  test.setTimeout(150_000)
  await gotoDeep(page, 'deep40')

  // 初始停在底部（mock 在 rAF 中设置 scrollTop = scrollHeight），等待阅读位置稳定
  await page.waitForTimeout(500)
  const initial = await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    return { scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight }
  })

  // 等 warmup 完整跑完（40 轮、初始 12 轮 → 探索 28 轮后到顶稳定）
  await expect
    .poll(async () => (await readDebug(page)).historyWarmup?.state, { timeout: 120_000 })
    .toBe('complete')
  expect((await readDebug(page)).historyWarmup?.reachedTop).toBe(true)

  // 完成后阅读位置必须回到初始锚点附近（懒加载 prepend 会使 scrollTop 增长，
  // 但锚定的阅读内容不变 —— 这里用"接近底部"作为锚点近似 + 允许像素误差）
  const final = await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    return { scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight }
  })
  const distanceFromBottom = final.scrollHeight - final.clientHeight - final.scrollTop
  expect(distanceFromBottom).toBeLessThan(600)
  expect(initial.scrollTop).toBeGreaterThan(0)
})

test('B7 - 用户主动滚动后：warmup 不得把页面拉回旧位置', async ({ page }) => {
  test.setTimeout(150_000)
  await gotoDeep(page, 'deep40')
  await page.waitForTimeout(500)

  // 等 warmup 开始探索
  await expect.poll(async () => warmupSteps(page), { timeout: 60_000 }).toBeGreaterThan(0)

  // 用户主动滚动到内容上部并保持空闲
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = 600
  })
  const userPosition = 600

  // warmup 恢复并运行至完成
  await expect
    .poll(async () => (await readDebug(page)).historyWarmup?.state, { timeout: 120_000 })
    .toBe('complete')

  // 完成后的位置必须以用户位置为基准（恢复目标 = 用户最近的有意位置），
  // 绝不能回到 warmup 开始时的底部
  const final = await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    return { scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight }
  })
  const distanceFromBottom = final.scrollHeight - final.clientHeight - final.scrollTop
  expect(distanceFromBottom).toBeGreaterThan(600)
  expect(Math.abs(final.scrollTop - userPosition)).toBeLessThan(2000)
})

test('B8 - detached full turn：目录不得显示"未加载"', async ({ page }) => {
  test.setTimeout(120_000)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)
  await page.click('button[data-act="add150-dup"]')
  await waitForMarkers(page, 162, 30_000)

  await page.click('button[data-act="virt-on"]')
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) / 2
  })
  await page.waitForTimeout(900)

  // 存在 detached（曾完整收获、当前被虚拟化卸载）的 turn
  const debug = await readDebug(page)
  expect(debug.storeTurns).toBe(162)
  expect(debug.turnRoots).toBeLessThan(162)

  // 打开目录：所有可见 item 都不得带"未加载 / 仅预览"标记（正文均已完整收获）
  await page.hover('.tn-rail')
  await expect.poll(async () => page.locator('.tn-item').count(), { timeout: 10_000 }).toBeGreaterThan(0)
  expect(await page.locator('.tn-flag').count()).toBe(0)
  expect(await page.locator('.tn-flag', { hasText: '未加载' }).count()).toBe(0)
})

test('B11 - manual capture 打断 warmup：滚动所有权唯一', async ({ page }) => {
  test.setTimeout(150_000)
  await gotoDeep(page, 'deep40')
  await expect.poll(async () => warmupSteps(page), { timeout: 60_000 }).toBeGreaterThan(2)

  // 打开目录面板（按钮在 footer 内，面板关闭时不可见）
  await page.hover('.tn-rail')
  await expect.poll(async () => page.locator('.tn-panel.tn-open').count(), { timeout: 10_000 }).toBe(1)

  // warmup 冷却窗口中点击"加载全部历史"
  await page.click('.tn-load-btn')
  const loadBtn = page.locator('.tn-load-btn')
  await expect.poll(async () => loadBtn.isDisabled(), { timeout: 10_000 }).toBe(true)

  const stepsAtCapture = await warmupSteps(page)
  // capture 进行中：warmup steps 冻结（manual capture 独占滚动）
  await page.waitForTimeout(1200)
  expect(await warmupSteps(page)).toBe(stepsAtCapture)

  // capture 到顶结束 → 按钮 恢复；剩余历史已被 manual capture 收获完毕，
  // warmup 不再产生任何新滚动（stopped = 缓存/捕获 complete 语义，规格 #35；
  // stopped 路径不设置 warmup 会话自身的 reachedTop —— 到顶证据属于 capture）
  await expect.poll(async () => loadBtn.isDisabled(), { timeout: 60_000 }).toBe(false)
  const after = await readDebug(page)
  expect(['stopped', 'complete']).toContain(after.historyWarmup?.state ?? '')
  expect(after.storeTurns).toBe(40)
})

test('B12 - recover 在 warmup 长会话环境下成功跳转（优先级合同见 W7 单元测试）', async ({
  page
}) => {
  test.setTimeout(600_000)
  await gotoDeep(page, 'deep120')

  // 等 warmup 会话完成（阅读位置恢复、视图与虚拟化窗口静止）再触发 recover，
  // 排除 warmup 批次滚动与 recover 互相争抢导致的非确定性
  //（deep120 全程约 4~5 分钟，超时给足）
  await expect
    .poll(async () => (await readDebug(page)).historyWarmup?.state, { timeout: 300_000 })
    .toBe('complete')

  // 滚动到视觉顶部并等虚拟化窗口稳定：窗口上方 turn 全部挂载、
  // 窗口下方（更新的 turn）处于 detached —— 目标取窗口正下方最近的一个，
  // recover 方向判定确定（dir=down），一至两次受控滚动即命中
  await page.evaluate(() => {
    const sc = document.getElementById('scroller') as HTMLElement
    sc.scrollTop = 0
  })
  await page.waitForTimeout(1_200)

  const target = await page.evaluate(() => {
    const store = (globalThis as any).__tn.store
    let last: string | null = null
    for (const turn of store.turns) {
      const el = store.getTurn(turn.id)?.user?.element
      if (!el || !el.isConnected) last = turn.id
    }
    return last
  })
  expect(target).not.toBeNull()

  // 先派发 wheel（complete 后为无操作，防御性保持"用户操作优先"合同语义），
  // 再经 DEBUG 跳转钩子触发（与点击目录项同一 handleJump → recoverAndJump 路径）；
  // 虚拟化窗口每 300ms 重写 thread（rail marker 全量重建），DOM 点击无法稳定命中
  await page.evaluate(() => {
    document
      .getElementById('scroller')!
      .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
  })
  await page.evaluate((id: string) => {
    ;(globalThis as any).__tn.jump(id)
  }, target as string)

  // 成功判据与 normal.spec recover 用例一致：recoverLog 出现 found=true
  //（跳转后的 active 由 scroll-spy 阅读带重新判定，不断言 active === 目标）
  const recoverFound = async (): Promise<boolean> =>
    page.evaluate(
      () =>
        ((globalThis as any).__tn.recoverLog() as string[]).some((line) =>
          line.includes('found=true')
        ) || false
    )

  const ok = await pollFor(recoverFound, (x) => x, 60_000)
  if (!ok) {
    const diag = await page.evaluate(() => ({
      recoverLog: ((globalThis as any).__tn.recoverLog() as string[]).slice(-5),
      warmState: (globalThis as any).__tnDebug.historyWarmup.state
    }))
    throw new Error(`recover 未命中目标: ${JSON.stringify(diag)}`)
  }

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)
})

/** 通用轮询：直到 predicate 满足或超时 */
async function pollFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeout: number): Promise<T> {
  const deadline = Date.now() + timeout
  let last = await fn()
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await fn()
  }
  return last
}

test('B13 - 路由隔离：A 会话 warmup 中切到 B，Store 无 A 数据、warmup 重置', async ({ page }) => {
  test.setTimeout(150_000)
  await gotoDeep(page, 'deep120')
  await expect.poll(async () => warmupSteps(page), { timeout: 60_000 }).toBeGreaterThan(2)
  const stepsA = await warmupSteps(page)

  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)

  // B 会话无 A 的 turn；warmup 计数归零重启
  const debug = await readDebug(page)
  expect(debug.storeTurns).toBe(8)
  expect(debug.historyWarmup?.steps ?? 0).toBeLessThanOrEqual(stepsA)

  const turns = await page.evaluate(() =>
    (globalThis as any).__tn.store.turns.map((turn: { title: string }) => turn.title)
  )
  for (const title of turns) expect(title).toContain('Q1')

  // B 会话的 warmup 重新按初始 idle 调度（A 的定时器已被取消）
  await page.waitForTimeout(6_500)
  const after = await readDebug(page)
  expect(after.storeTurns).toBe(8)
})

test('B14 - no busy loop：complete 后 steps / batches / full scans 停止增长', async ({ page }) => {
  test.setTimeout(150_000)
  await gotoDeep(page, 'deep40')

  await expect
    .poll(async () => (await readDebug(page)).historyWarmup?.state, { timeout: 120_000 })
    .toBe('complete')

  const settled = await readDebug(page)
  const batches = settled.historyWarmup?.batches ?? 0
  const steps = settled.historyWarmup?.steps ?? 0
  const fullScans = settled.performance?.indexer.fullScans ?? 0

  await page.waitForTimeout(12_000)
  const after = await readDebug(page)
  expect(after.historyWarmup?.batches).toBe(batches)
  expect(after.historyWarmup?.steps).toBe(steps)
  expect(after.performance?.indexer.fullScans).toBe(fullScans)
})

test('B15 - 长会话性能：无 full-scan storm、无单次长 batch', async ({ page }) => {
  test.setTimeout(420_000)
  await gotoDeep(page, 'deep120')

  await expect
    .poll(async () => (await readDeep(page)).pendingHistoryCount, { timeout: 360_000 })
    .toBe(0)
  await expect
    .poll(async () => (await readDebug(page)).historyWarmup?.state, { timeout: 120_000 })
    .toBe('complete')

  const perf = (await readDebug(page)).performance
  const warmup = perf?.historyWarmup
  expect(warmup).toBeTruthy()
  // 性能合同（规格 #52）：warmup 每 batch 至多贡献 1 次 full scan。
  // fullScans 还含启动扫描与虚拟化窗口重写引发的偶发 fallback（与 warmup 无关），
  // 预留 8 次余量 —— 真正的 full-scan storm（如每 step 一次）会是 +几十次量级
  const batches = warmup?.batches ?? 0
  const fullScans = perf?.indexer.fullScans ?? 0
  expect(fullScans).toBeLessThanOrEqual(batches + 8)
  // 无单次长任务：batch 墙钟远小于 manual capture 的 45s 量级
  expect(warmup?.maxBatchMs ?? 0).toBeLessThan(1800)
})

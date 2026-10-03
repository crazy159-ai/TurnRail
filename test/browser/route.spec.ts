import { test, expect } from '@playwright/test'
import { gotoWithDebug, readDebug, waitForMarkers, expectPoll } from './helpers'

/**
 * Route Lifecycle 浏览器测试（B19–B31，规格 #37–#48 + eventual recovery）：
 * 测试台 test/mock/route.html —— 全部会话使用确定性 turn id、chrome.storage
 * 内存模拟、History.prototype 原生路由动作（绕过任何实例级 wrapper，等价
 * isolated world 中 MAIN world 页面自行导航）。
 *
 * 核心验收：event fast path 真正生效（不是 800ms/300ms 轮询蒙混）、
 * URL/DOM 时序竞态下旧内容绝不冒充新会话、rapid A→B→C 收敛、
 * 缓存 / Health / History / Handoff 严格会话隔离；以及 Phase B 最终
 * 确定性恢复 —— fast 窗口耗尽后 DOM 迟到（same-root 原地换 / root 换代 /
 * 慢加载）也必须零交互自动就绪，绝不永久卡在 Transition Gate（B28–B31）。
 */

const MOCK = '/test/mock/route.html'

/** 读取当前 Store 的 turn id 列表（确定性 id，直接断言会话归属） */
async function readStoreTurnIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (globalThis as any).__tn?.store
    return store ? store.turns.map((turn: { id: string }) => turn.id) : []
  })
}

async function readRouteLifecycle(page: import('@playwright/test').Page) {
  const debug = await readDebug(page)
  return debug.routeLifecycle
}

test.beforeEach(async ({ page }) => {
  await gotoWithDebug(page, MOCK)
  // 初始挂载：会话 A 的 12 轮（observer 增量收获初始 DOM）
  await waitForMarkers(page, 12)
})

test('B19: 原生 History.prototype 导航（绕过任何 wrapper）→ Navigation API 立即同步 B', async ({
  page
}) => {
  await page.click('button[data-act="native-b"]')

  // lastSource 必须是 navigation-api —— 旧实现只能靠轮询蒙混（规格 #40）
  await expectPoll(async () => (await readRouteLifecycle(page))?.lastSource, 'navigation-api')
  await waitForMarkers(page, 24)

  const ids = await readStoreTurnIds(page)
  expect(ids).toHaveLength(24)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)

  const debug = await readDebug(page)
  expect(debug.storeTurns).toBe(24)
  expect(debug.markers).toBe(24)
  // Health 已随 B 重算（隔离断言的基线）
  expect((debug.performance?.health.analyzes ?? 0)).toBeGreaterThan(0)
})

test('B20: URL 先行、DOM 延迟 300ms —— 过渡窗口内 Store 为空，绝不出现 B 身份 + A 内容', async ({
  page
}) => {
  await page.click('button[data-act="slow-native-b"]')

  // t0+ε：路由已切 B，但 thread 仍是 A 的 DOM —— TurnRail 必须清空并保持等待
  const mid = await readDebug(page)
  expect(mid.routeLifecycle?.transitioning).toBe(true)
  expect(mid.storeTurns).toBe(0) // 过渡窗口内 Store 不得含 A 的内容
  expect(mid.markers).toBe(0)

  // 期间轮询不得把 A DOM 扫进 B Store（轮询只做 O(1) 身份比较，规格 #51）
  await page.waitForTimeout(120)
  const mid2 = await readDebug(page)
  expect(mid2.storeTurns).toBe(0)

  // t0+300ms：B DOM 到达 → gate 确认签名变化 → live B
  await waitForMarkers(page, 24)
  const end = await readDebug(page)
  expect(end.routeLifecycle?.transitioning).toBe(false)
  expect(end.routeLifecycle?.lastReadyMs).not.toBeNull()
  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
})

test('B21: root 复用（replaceChildren 原地换内容）→ 签名变化被识别，不永远等待', async ({
  page
}) => {
  await page.click('button[data-act="reuse-root-b"]')

  await expectPoll(async () => (await readRouteLifecycle(page))?.lastSource, 'navigation-api')
  await waitForMarkers(page, 24)

  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
  const debug = await readDebug(page)
  expect(debug.routeLifecycle?.transitioning).toBe(false)
})

test('B22: rapid A → B → C —— B 迟到 DOM 被取代，最终只有 C', async ({ page }) => {
  await page.click('button[data-act="slow-native-b"]')
  await page.waitForTimeout(50)
  await page.click('button[data-act="native-c"]')

  await waitForMarkers(page, 6)

  const ids = await readStoreTurnIds(page)
  expect(ids).toHaveLength(6)
  expect(ids.every((id) => id.startsWith('kc-'))).toBe(true)

  // 等 B 的迟到渲染窗口彻底过去（300ms + 余量）：B 的 DOM 被取代，绝不允许回写
  await page.waitForTimeout(500)
  const idsAfter = await readStoreTurnIds(page)
  expect(idsAfter.every((id) => id.startsWith('kc-'))).toBe(true)
  expect(idsAfter.some((id) => id.startsWith('kb-'))).toBe(false)
  expect(idsAfter.some((id) => id.startsWith('ka-'))).toBe(false)

  const debug = await readDebug(page)
  expect(debug.storeTurns).toBe(6)
  expect(debug.markers).toBe(6)
  expect(debug.routeLifecycle?.transitioning).toBe(false)
  expect((debug.routeLifecycle?.generation ?? 0)).toBeGreaterThanOrEqual(3)
  expect((debug.routeLifecycle?.lastSource ?? '')).toBe('navigation-api')
})

test('B23: 同会话 query / hash 变化 —— 不重置、不重算、不重建 Observer', async ({ page }) => {
  // 启动稳定性扫描（退避表至 ~5.9s）彻底结束后再取基线，排除自然漂移
  await page.waitForTimeout(6500)
  const before = await readDebug(page)
  const generationBefore = before.routeLifecycle?.generation
  const analyzesBefore = before.performance?.health.analyzes ?? 0
  const scansBefore = before.performance?.indexer.fullScans ?? 0

  await page.click('button[data-act="query-same"]')
  await page.waitForTimeout(600) // 覆盖多个轮询周期：轮询也必须去重
  await page.click('button[data-act="hash-same"]')
  await page.waitForTimeout(600)

  const after = await readDebug(page)
  expect(after.routeLifecycle?.generation).toBe(generationBefore) // generation 不得推进
  expect(after.routeLifecycle?.transitioning).toBe(false)
  expect(after.storeTurns).toBe(12)
  expect(after.markers).toBe(12)
  expect((after.performance?.health.analyzes ?? 0)).toBe(analyzesBefore) // Health 不得重算
  expect((after.performance?.indexer.fullScans ?? 0)).toBe(scansBefore) // 不得触发重建扫描

  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('ka-'))).toBe(true)
})

test('B24: 新聊天首条消息（/ → /c/<new-id>）→ 身份立即切换，无需刷新', async ({ page }) => {
  await page.click('button[data-act="native-home"]')
  await waitForMarkers(page, 0)
  expect((await readRouteLifecycle(page))?.conversationIdPresent).toBe(false)

  await page.click('button[data-act="new-chat-send"]')

  await expectPoll(async () => (await readRouteLifecycle(page))?.conversationIdPresent, true)
  await waitForMarkers(page, 1)

  const ids = await readStoreTurnIds(page)
  expect(ids).toEqual(['kn-001'])
  expect((await readRouteLifecycle(page))?.transitioning).toBe(false)

  // Observer 正确重绑：追加第 2 轮应被增量收获（无需刷新）
  await page.click('button[data-act="add1"]')
  await waitForMarkers(page, 2)
  expect(await readStoreTurnIds(page)).toEqual(['kn-001', 'kn-002'])
})

test('B25: 浏览器后退 / 前进 —— TurnRail 正确跟随（traversal 路径）', async ({ page }) => {
  await page.click('button[data-act="native-b"]')
  await waitForMarkers(page, 24)

  // 后退：popstate 与 currententrychange 在 traversal 上都会触发（Chromium 中
  // currententrychange 先到），二者任一作为来源都成立 —— 数据正确性是关键断言
  await page.evaluate(() => history.back())
  await expectPoll(
    async () => (await readRouteLifecycle(page))?.lastSource,
    'popstate',
    10_000
  ).catch(async () => {
    // traversal 上 navigation-api 与 popstate 的先后属浏览器实现细节：
    // 只要来源是事件路径（非 poll）且回退正确即为通过
    const source = (await readRouteLifecycle(page))?.lastSource
    expect(['popstate', 'navigation-api']).toContain(source)
  })
  await waitForMarkers(page, 12)
  let ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('ka-'))).toBe(true)

  await page.evaluate(() => history.forward())
  await expectPoll(
    async () => ['popstate', 'navigation-api'].includes(
      String((await readRouteLifecycle(page))?.lastSource)
    ),
    true
  )
  await waitForMarkers(page, 24)
  ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
  expect((await readRouteLifecycle(page))?.transitioning).toBe(false)
})

test('B26: 缓存隔离 —— A 的迟到 cache read 绝不 hydrate B；切回 A 才恢复', async ({ page }) => {
  // 初始 A：预置缓存命中（cache-first 链路在浏览器测试台首次真实启用）
  await expectPoll(async () => (await readDebug(page)).cache?.hydratedTurns, 12, 15_000)

  // 制造竞态：A 的 cache read 延迟 800ms；先回到 A 触发一次在途读取
  await page.click('button[data-act="conv-b"]')
  await waitForMarkers(page, 24)
  await page.evaluate(() => {
    const control = (globalThis as any).__tnCacheControl
    control.delayKey = 'turnrail:conversation:chatgpt:mock-aaaa-1111-4444'
    control.delayMs = 800
  })
  await page.click('button[data-act="conv-a"]')
  // A 的 cache read 还在途（800ms）；200ms 后切 B —— generation 已推进
  await page.waitForTimeout(200)
  await page.click('button[data-act="conv-b"]')
  await waitForMarkers(page, 24)

  // A 的迟到 cache read 到达：必须被 generation 守卫丢弃，B 只有 kb-*
  await page.waitForTimeout(900)
  let ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
  expect(ids.some((id) => id.startsWith('ka-'))).toBe(false)
  const bDebug = await readDebug(page)
  expect(bDebug.cache?.hydratedTurns).toBeNull()

  // 切回 A：A 的 cache（延迟读取）此时才允许 hydrate
  await page.click('button[data-act="conv-a"]')
  await expectPoll(async () => (await readDebug(page)).cache?.hydratedTurns, 12, 15_000)
  await waitForMarkers(page, 12)
  ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('ka-'))).toBe(true)
})

test('B27: PassiveTopWatch 隔离 —— A 的 reachedTop 不残留 B，B 重新确认到顶', async ({
  page
}) => {
  // deep72：模拟用户分页式向上翻阅懒加载历史（TurnRail 绝不代滚 —— mock 的
  // prepend 滚动锚定补偿会把视口推离顶部，必须像真实用户一样逐页滚到顶）
  await page.click('button[data-act="native-deep72"]')
  await waitForMarkers(page, 12)
  for (let round = 0; round < 15; round++) {
    const pending = await page.evaluate(() => (globalThis as any).__deep.pendingHistoryCount())
    if (pending === 0) break
    await page.evaluate(() => {
      ;(document.getElementById('scroller') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(350)
  }
  // 最后一页停在视觉顶部：去抖 500ms + 稳定窗口 1500ms 后被动确认到顶
  await page.evaluate(() => {
    ;(document.getElementById('scroller') as HTMLElement).scrollTop = 0
  })
  await expectPoll(
    async () => (await readDebug(page)).historyCoverage?.state,
    'complete',
    15_000
  )
  expect((await readDebug(page)).historyCoverage?.reachedTop).toBe(true)

  // 切 B：到顶证据必须立即失效（规格 #34/#48）
  await page.click('button[data-act="native-b"]')
  await waitForMarkers(page, 24)
  const afterSwitch = await readDebug(page)
  expect(afterSwitch.historyCoverage?.reachedTop).toBe(false)
  expect(afterSwitch.historyCoverage?.state).toBe('partial')

  // B 自然到顶：watcher 必须重新武装（不能因 A 的 confirmed=true 而失效）。
  // 先滚离再滚回 —— deep 阶段结束时视口已在顶部，直接置 0 不产生 scroll 事件
  await page.evaluate(() => {
    const scroller = document.getElementById('scroller') as HTMLElement
    scroller.scrollTop = 60
  })
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    const scroller = document.getElementById('scroller') as HTMLElement
    scroller.scrollTop = 0
  })
  await expectPoll(
    async () => (await readDebug(page)).historyCoverage?.reachedTop,
    true,
    15_000
  )
})

test('B28: late same-root swap —— DOM 在 fast 窗口后 2.5s 才原地换 B，零交互自动恢复', async ({
  page
}) => {
  // 真实 P0 场景：URL=B 但 React 2.5s 后才 replaceChildren（root 不消失、
  // 无 focus / visibility 变化）—— RootWatch 与事件恢复都打不到，只有
  // Mutation Wake / Recovery Poll 能兜住（规格：VALID_NEW_DOM → EVENTUALLY READY）
  await page.click('button[data-act="late-swap-b"]')

  const mid = await readDebug(page)
  expect(mid.routeLifecycle?.transitioning).toBe(true)
  expect(mid.storeTurns).toBe(0)
  expect(mid.markers).toBe(0)

  // fast 窗口（~1.57s）耗尽后：仍不就绪、Store 仍空、进入低频恢复模式
  await page.waitForTimeout(2200)
  const mid2 = await readDebug(page)
  expect(mid2.routeLifecycle?.transitioning).toBe(true)
  expect(mid2.storeTurns).toBe(0)
  expect(['mutation-wait', 'recovery-poll']).toContain(mid2.routeLifecycle?.transitionMode)

  // t=2.5s：B DOM 原地换入 → 自动恢复（全程无点击 / 无切 tab / 无刷新）
  await waitForMarkers(page, 24)
  const end = await readDebug(page)
  expect(end.routeLifecycle?.transitioning).toBe(false)
  expect(end.routeLifecycle?.transitionMode).toBe('ready')
  expect(end.markers).toBe(24)
  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
})

test('B29: DOM 先换成 B、route event 后到 —— previous 取 accepted A 签名，立即就绪', async ({
  page
}) => {
  // A 已接受：accepted 基线必须已建立（DEBUG-only boolean，不含任何 ID）
  await expectPoll(async () => (await readRouteLifecycle(page))?.acceptedSignaturePresent, true)

  // Order B（规格 #23）：DOM → route event。若 previous 读 route-event 后的
  // 当前 DOM（= B），则 previous == current → gate 永久等待（P0 根因 2）
  await page.click('button[data-act="dom-first-b"]')

  await waitForMarkers(page, 24)
  const end = await readDebug(page)
  expect(end.routeLifecycle?.transitioning).toBe(false)
  expect(end.routeLifecycle?.acceptedSignaturePresent).toBe(true)
  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)

  // route event（~150ms）到达时首探测即 ready：远小于 fast 窗口
  expect(end.routeLifecycle?.lastReadyMs ?? 9999).toBeLessThan(1500)
})

test('B30: 旧 root 保留 >2s 后移除并插入全新 root —— wake / recovery 识别 root 换代', async ({
  page
}) => {
  await page.click('button[data-act="late-root-replace-b"]')

  await page.waitForTimeout(400)
  expect((await readDebug(page)).routeLifecycle?.transitioning).toBe(true)

  // t=2.3s：旧 root remove + 新 root insert（fast 窗口已耗尽）
  await waitForMarkers(page, 24, 15_000)
  const end = await readDebug(page)
  expect(end.routeLifecycle?.transitioning).toBe(false)
  // 就绪必须由恢复路径驱动（mutation wake 或 recovery poll 二者其一）
  expect(
    (end.routeLifecycle?.mutationWakeCount ?? 0) + (end.routeLifecycle?.recoveryProbeCount ?? 0)
  ).toBeGreaterThanOrEqual(1)
  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
  expect(end.markers).toBe(24)
})

test('B31: DOM 延迟 4.5s（超所有 fast probe）—— 不 focus / 不切 tab，transitioning 最终必然 false', async ({
  page
}) => {
  await page.click('button[data-act="very-slow-native-b"]')

  const mid = await readDebug(page)
  expect(mid.routeLifecycle?.transitioning).toBe(true)
  expect(mid.storeTurns).toBe(0)

  // t≈2.2s：fast 已耗尽、无任何用户交互 —— gate 必须仍活着而不是死等
  await page.waitForTimeout(2000)
  const mid2 = await readDebug(page)
  expect(mid2.routeLifecycle?.transitioning).toBe(true)
  expect(mid2.storeTurns).toBe(0)
  expect(['mutation-wait', 'recovery-poll']).toContain(mid2.routeLifecycle?.transitionMode)
  // 低干扰 footer 提示（>1.2s 未就绪；无 toast / 无 spinner）
  expect(await page.locator('.tn-status').textContent()).toBe('正在同步当前对话…')

  // t=4.5s DOM 到达 → 最终就绪（真实用户"侧边栏一直不加载"的最终防线）
  await waitForMarkers(page, 24)
  const end = await readDebug(page)
  expect(end.routeLifecycle?.transitioning).toBe(false)
  expect(end.routeLifecycle?.transitionMode).toBe('ready')
  expect(await page.locator('.tn-status').textContent()).toBe('')
  const ids = await readStoreTurnIds(page)
  expect(ids.every((id) => id.startsWith('kb-'))).toBe(true)
})

test('Route 隐私合同: routeLifecycle 元数据不含会话 ID / URL（规格 #56/#57）', async ({
  page
}) => {
  await page.click('button[data-act="native-b"]')
  await waitForMarkers(page, 24)

  const lifecycle = await page.evaluate(() => {
    const debug = (globalThis as any).__tnDebug
    return JSON.stringify(debug.routeLifecycle)
  })
  expect(lifecycle).not.toContain('mock-bbbb-2222-4444')
  expect(lifecycle).not.toContain('/c/')
  expect(lifecycle).not.toContain('kb-')

  // copyDiagnostics 导出同样不含会话身份
  const diagnostics = await page.evaluate(() => (globalThis as any).__tn.copyDiagnostics())
  expect(diagnostics).not.toContain('mock-bbbb-2222-4444')
  expect(diagnostics).not.toContain('kb-')
})

test('Route 无错误: 全流程零未捕获异常 / 零后台滚动回归', async ({ page }) => {
  await page.click('button[data-act="slow-native-b"]')
  await page.waitForTimeout(50)
  await page.click('button[data-act="native-c"]')
  await page.waitForTimeout(400)
  await page.click('button[data-act="native-a"]')
  await waitForMarkers(page, 12)
  await page.click('button[data-act="native-home"]')
  await page.waitForTimeout(200)
  await page.click('button[data-act="new-chat-send"]')
  await waitForMarkers(page, 1)

  const errCount = await page.evaluate(() => (globalThis as any).__tnErrCount ?? 0)
  expect(errCount).toBe(0)

  // BACKGROUND_TASK_MUST_NOT_SCROLL：在可滚动会话内静置 1.5s，
  // 滚动位置不得被 TurnRail 改动
  await page.click('button[data-act="native-a"]')
  await waitForMarkers(page, 12)
  const scrollBefore = await page.evaluate(() => {
    const scroller = document.getElementById('scroller') as HTMLElement
    scroller.scrollTop = 40
    return scroller.scrollTop
  })
  expect(scrollBefore).toBe(40)
  await page.waitForTimeout(1500)
  const scrollAfter = await page.evaluate(
    () => (document.getElementById('scroller') as HTMLElement).scrollTop
  )
  expect(scrollAfter).toBe(40)
})

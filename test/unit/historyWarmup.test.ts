import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationIndexer } from '../../src/conversation/indexer.ts'
import {
  createHistoryWarmupController,
  computeHistoryCoverage,
  warmupStatusText,
  DEFAULT_HISTORY_WARMUP_POLICY,
  type WarmupTimers
} from '../../src/conversation/historyWarmup.ts'
import { createUserActivityMonitor } from '../../src/content/userActivity.ts'
import { hydrateCachedConversation } from '../../src/cache/hydrator.ts'
import { fakeProvider, liveTurn, makeCached, makeTurn, fakeElement } from './helpers.ts'
import type { ConversationMessage } from '../../src/conversation/types.ts'
import type { ChatProvider, LocatedTurn } from '../../src/providers/types.ts'

/**
 * Background History Warmup 单元合同（规格 #59 W1-W14 + #56/#57 completeness 合同）。
 * 全部使用假时钟 / 假容器：验证调度、门控、中断、退避与完成判定，
 * 不依赖真实 DOM —— 真实滚动 / 懒加载行为由浏览器测试覆盖。
 */

// scrollGeometry 读取 window.getComputedStyle（仅调用时）；Node 环境提供最小 stub
;(globalThis as unknown as Record<string, unknown>).window = {
  getComputedStyle: () => ({ flexDirection: 'column' })
}

interface FakeElementLike {
  isConnected: boolean
  getBoundingClientRect?(): { top: number }
}

const TURN_HEIGHT = 800

/** 假时钟 + 假定时器：advance 逐个触发到期回调并 flush 微任务 */
class FakeClock {
  now = 0
  private seq = 0
  private tasks = new Map<number, { at: number; callback: () => void }>()

  timers(): WarmupTimers {
    return {
      setTimeout: (callback, ms) => {
        const id = ++this.seq
        this.tasks.set(id, { at: this.now + ms, callback })
        return id
      },
      clearTimeout: (handle) => {
        this.tasks.delete(handle as number)
      }
    }
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      let nextId: number | undefined
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at
          nextId = id
        }
      }
      if (nextId === undefined) break
      this.now = nextAt
      const task = this.tasks.get(nextId)!
      this.tasks.delete(nextId)
      task.callback()
      // flush 微任务链（async runBatch 的续体会在其间注册新定时器）
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    this.now = target
  }
}

interface ManagedTurn extends LocatedTurn {
  mounted: boolean
}

/** 假滚动容器（normal 坐标系：scrollTop ∈ [0, extent]，0 = 视觉顶部） */
function makeContainer(scrollTop: number): {
  el: HTMLElement
  state: { scrollTop: number; scrollHeight: number }
} {
  const state = { scrollTop, scrollHeight: 6000 }
  const el = {
    get clientHeight() {
      return 1000
    },
    get scrollHeight() {
      return state.scrollHeight
    },
    get scrollTop() {
      return state.scrollTop
    },
    set scrollTop(value: number) {
      state.scrollTop = Math.min(Math.max(0, value), state.scrollHeight - 1000)
    },
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  return { el, state }
}

interface TestEnv {
  clock: FakeClock
  store: ConversationStore
  indexer: ConversationIndexer
  activity: ReturnType<typeof createUserActivityMonitor>
  warmup: ReturnType<typeof createHistoryWarmupController>
  container: ReturnType<typeof makeContainer>
  turns: ManagedTurn[]
  scanCount(): number
  lazyLoad(count: number): void
  setGeneration(value: number): void
  setCaptureRunning(value: boolean): void
  setRecoverRunning(value: boolean): void
  setVisible(value: boolean): void
}

interface EnvOptions {
  totalTurns?: number
  mountedTurns?: number
  initialScrollTop?: number
  policy?: Partial<typeof DEFAULT_HISTORY_WARMUP_POLICY>
}

function makeEnv(options: EnvOptions = {}): TestEnv {
  const clock = new FakeClock()
  const total = options.totalTurns ?? 24
  const mountedCount = options.mountedTurns ?? 12

  const store = new ConversationStore()
  store.reset('conv-1')

  const turns: ManagedTurn[] = []
  for (let i = 1; i <= total; i++) {
    const located = liveTurn(`q${i}`, `问题 ${i} 的完整提问内容`)
    const turn: ManagedTurn = { ...located, mounted: false }
    setMounted(turn, i > total - mountedCount)
    turns.push(turn)
  }

  const container = makeContainer(options.initialScrollTop ?? 3000)

  // 元素矩形模型（normal 坐标）：视口 top = contentY - scrollTop；
  // contentY = index × TURN_HEIGHT（懒加载 prepend 用 scrollTop 同步增长模拟锚定）
  turns.forEach((turn, index) => {
    const contentY = index * TURN_HEIGHT
    for (const el of [turn.root, turn.user!.element, turn.assistant!.element]) {
      ;(el as FakeElementLike).getBoundingClientRect = () => ({
        top: contentY - container.state.scrollTop
      })
    }
  })

  const mountedTurns = (): LocatedTurn[] =>
    turns.filter((turn) => turn.mounted).map(({ mounted: _m, ...rest }) => rest)

  const provider: ChatProvider = {
    ...fakeProvider([]),
    locateTurns: mountedTurns,
    locateTurnRoots: () =>
      turns.filter((turn) => turn.mounted).map((turn) => ({ id: turn.id, root: turn.root })),
    getScrollContainer: () => container.el,
    getConversationId: () => 'conv-1',
    lastLocatedCount: turns.filter((turn) => turn.mounted).length
  }

  // 用真实 Indexer（与生产同一路径）；包装 scan 统计调用次数
  const indexer = new ConversationIndexer(provider, store)
  let scans = 0
  const originalScan = indexer.scan.bind(indexer)
  indexer.scan = (force?: boolean, isFallback?: boolean) => {
    scans++
    return originalScan(force, isFallback)
  }
  // 预置启动扫描（生产环境中 warmup 启动前 startup scan / observer 早已填充 Store）；
  // 直接走原始 scan，不计入 batch 合同统计
  originalScan(true)

  const activity = createUserActivityMonitor({ now: () => clock.now })

  let generation = 1
  let captureRunning = false
  let recoverRunning = false
  let visible = true

  const warmup = createHistoryWarmupController({
    provider,
    indexer,
    store,
    activity,
    isCaptureRunning: () => captureRunning,
    isRecoverRunning: () => recoverRunning,
    getGeneration: () => generation,
    isVisible: () => visible,
    policy: options.policy,
    timers: clock.timers(),
    now: () => clock.now
  })

  return {
    clock,
    store,
    indexer,
    activity,
    warmup,
    container,
    turns,
    scanCount: () => scans,
    lazyLoad(count: number): void {
      // 模拟 ChatGPT lazy loading：最旧的未挂载 turn 逐个 mount（prepend 于视觉顶部之上），
      // scroll anchoring 保持视口内容不动（scrollHeight 与 scrollTop 同步增长）
      let loaded = 0
      for (const turn of turns) {
        if (loaded >= count) break
        if (!turn.mounted) {
          setMounted(turn, true)
          loaded++
        }
      }
      container.state.scrollHeight += loaded * TURN_HEIGHT
      container.state.scrollTop += loaded * TURN_HEIGHT
    },
    setGeneration: (value) => {
      generation = value
    },
    setCaptureRunning: (value) => {
      captureRunning = value
    },
    setRecoverRunning: (value) => {
      recoverRunning = value
    },
    setVisible: (value) => {
      visible = value
    }
  }
}

function setMounted(turn: ManagedTurn, mounted: boolean): void {
  turn.mounted = mounted
  ;(turn.root as FakeElementLike).isConnected = mounted
  ;(turn.user!.element as FakeElementLike).isConnected = mounted
  if (turn.assistant) (turn.assistant.element as FakeElementLike).isConnected = mounted
}

test('W1 - idle start: 用户空闲达到阈值后 scheduled → warming 并执行 batch', async () => {
  const env = makeEnv()
  env.warmup.start()
  assert.equal(env.warmup.snapshot().state, 'scheduled')

  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs - 100)
  assert.equal(env.warmup.snapshot().batches, 0)

  await env.clock.advance(100 + DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 3)
  const snapshot = env.warmup.snapshot()
  assert.ok(snapshot.batches >= 1, '空闲达到阈值后应执行至少一个 batch')
  assert.ok(snapshot.steps >= 1, 'batch 应包含滚动 step')
  assert.ok(['warming', 'scheduled', 'paused'].includes(snapshot.state))
})

test('W2 - user activity pause: batch 前用户活动 → 不执行 scroll，空闲后恢复', async () => {
  const env = makeEnv()
  env.warmup.start()
  await env.clock.advance(4000)
  env.activity.markUserActivity() // 距首轮 gate 1s → 未满足 userIdleMs
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs - 4000)

  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.batches, 0)
  assert.equal(snapshot.steps, 0)
  assert.equal(snapshot.state, 'paused')
  assert.equal(snapshot.pausedReason, 'user-active')

  await env.clock.advance(
    DEFAULT_HISTORY_WARMUP_POLICY.userIdleMs + DEFAULT_HISTORY_WARMUP_POLICY.pausedRecheckMs + 2000
  )
  assert.ok(env.warmup.snapshot().batches >= 1, '空闲恢复后 recheck 应放行')
})

test('W3 - mid-batch interruption: 第一步后用户活动，第二步不得继续', async () => {
  const env = makeEnv()
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs)
  // 此刻 batch 已执行第一步（scrollTop 已移动）、正在 settle 等待
  assert.ok(env.container.state.scrollTop < 3000, '第一步应已移动滚动位置')
  env.activity.markUserActivity()
  const scrollTopDuringSettle = env.container.state.scrollTop

  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 3)
  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.steps, 1, '用户活动后不得执行第二步')
  assert.equal(snapshot.state, 'paused')
  assert.equal(snapshot.pausedReason, 'user-active')
  assert.equal(env.container.state.scrollTop, scrollTopDuringSettle, '中断后不得继续移动滚动位置')
})

test('W4 - no anchor override: batch 中用户主动滚动 → 用户位置优先', async () => {
  const env = makeEnv()
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs)
  assert.ok(env.container.state.scrollTop < 3000, 'warmup 应已向视觉顶部移动')

  // 用户在 settle 期间主动滚动到新位置
  env.activity.markUserActivity()
  env.container.state.scrollTop = 1234

  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 3)
  assert.equal(env.container.state.scrollTop, 1234, '用户位置优先，不得跳回 warmup 前的位置')
})

test('W4b - 会话完成（到顶稳定）→ 恢复同一阅读锚点（规格 #19/B6）', async () => {
  // 16 turn、挂载 12、初始 scrollTop 1200：约 5 个 batch 探索完剩余 4 turn 并到顶
  const env = makeEnv({ totalTurns: 16, mountedTurns: 12, initialScrollTop: 1200 })
  env.warmup.start()
  for (let round = 0; round < 40; round++) {
    if (env.warmup.snapshot().state === 'complete') break
    await env.clock.advance(100)
    if (env.turns.some((turn) => !turn.mounted)) env.lazyLoad(4)
    await env.clock.advance(2600)
  }
  assert.equal(env.warmup.snapshot().state, 'complete')
  assert.equal(env.warmup.snapshot().reachedTop, true)
  // 懒加载 prepend 使内容整体下移（anchoring：scrollTop 同步增长），
  // 阅读锚点应恢复到"同一内容" = 初始位置 + 全部 prepend 增量
  const prepended = env.container.state.scrollHeight - 6000
  assert.equal(env.container.state.scrollTop, 1200 + prepended)
})

test('W5 - assistant streaming pause: 流式静默期内 0 step，静默后恢复', async () => {
  const env = makeEnv()
  env.warmup.start()
  await env.clock.advance(4200)
  env.activity.markAssistantStream() // streaming 开始
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs - 4200)

  let snapshot = env.warmup.snapshot()
  assert.equal(snapshot.steps, 0)
  assert.equal(snapshot.pausedReason, 'assistant-streaming')

  await env.clock.advance(
    DEFAULT_HISTORY_WARMUP_POLICY.streamingQuietMs + DEFAULT_HISTORY_WARMUP_POLICY.pausedRecheckMs + 200
  )
  snapshot = env.warmup.snapshot()
  assert.ok(snapshot.steps >= 1, '静默后应恢复 warmup')
})

test('W6 - manual capture priority: capture 运行期间 0 scroll', async () => {
  const env = makeEnv()
  env.setCaptureRunning(true)
  env.warmup.start()
  await env.clock.advance(
    DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + DEFAULT_HISTORY_WARMUP_POLICY.pausedRecheckMs * 3
  )

  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.steps, 0)
  assert.equal(snapshot.pausedReason, 'manual-capture')
})

test('W7 - recover priority: recover 运行期间 0 scroll', async () => {
  const env = makeEnv()
  env.setRecoverRunning(true)
  env.warmup.start()
  await env.clock.advance(
    DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + DEFAULT_HISTORY_WARMUP_POLICY.pausedRecheckMs * 3
  )

  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.steps, 0)
  assert.equal(snapshot.pausedReason, 'recover')
})

test('W8 - route change cancellation: batch 中 generation 变化 → 0 scan / 0 restore / 0 污染', async () => {
  const env = makeEnv()
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs)
  assert.ok(env.container.state.scrollTop < 3000, '第一步应已执行')

  // batch settle 期间切换路由（generation++）
  env.setGeneration(99)
  const scrollTopAtSwitch = env.container.state.scrollTop
  const turnsBefore = env.store.turns.length

  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 6)
  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.state, 'stopped', '路由切换后 warmup 应停止')
  assert.equal(env.container.state.scrollTop, scrollTopAtSwitch, '不得再移动 / 恢复滚动')
  assert.equal(env.store.turns.length, turnsBefore, 'B 会话不得被迟到 batch 的 scan 改写')

  // 后续时间推进不得产生任何新 batch
  await env.clock.advance(60_000)
  assert.equal(env.warmup.snapshot().batches, 0)

  // 迟到的调度回调同样被忽略
  env.warmup.schedule(10)
  await env.clock.advance(50)
  assert.equal(env.warmup.snapshot().batches, 0)
})

test('W9 - productive backoff: 有新 turn → 短冷却', async () => {
  const env = makeEnv({ initialScrollTop: 3000 })
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs)
  // 第一个 batch 的 settle 中 lazy load → scan 发现新 turn → productive
  env.lazyLoad(6)
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 4)
  assert.equal(env.warmup.snapshot().batches, 1)
  assert.ok(env.store.turns.length > 12, 'lazy load 的 turn 应进入 Store')

  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.productiveCooldownMs - 200)
  assert.equal(env.warmup.snapshot().batches, 1, '短冷却内不得启动下一批')
  await env.clock.advance(400)
  assert.equal(env.warmup.snapshot().batches, 2, '短冷却后应启动下一批')
})

test('W10 - 位置前沿推进 → 短冷却持续；到顶稳定后 complete', async () => {
  // 全部已挂载、scrollTop 500：无新 turn 可收获，但位置前沿每 batch 推进 → 短冷却
  const env = makeEnv({ totalTurns: 24, mountedTurns: 24, initialScrollTop: 3000 })
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 4)
  assert.equal(env.warmup.snapshot().batches, 1)

  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.productiveCooldownMs - 300)
  assert.equal(env.warmup.snapshot().batches, 1, '前沿推进按 productive 短冷却调度')
  await env.clock.advance(600)
  assert.equal(env.warmup.snapshot().batches, 2)

  // 推进到顶并稳定 → complete
  for (let round = 0; round < 40; round++) {
    if (env.warmup.snapshot().state === 'complete') break
    await env.clock.advance(3000)
  }
  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.state, 'complete')
  assert.equal(snapshot.reachedTop, true)
})

test('W11 - complete detection: 懒加载历史耗尽 + 视觉顶部稳定 → complete 且不再调度', async () => {
  const env = makeEnv({ totalTurns: 24, mountedTurns: 12, initialScrollTop: 3000 })
  env.warmup.start()

  for (let round = 0; round < 80; round++) {
    if (env.warmup.snapshot().state === 'complete') break
    await env.clock.advance(100)
    if (env.turns.some((turn) => !turn.mounted)) env.lazyLoad(24)
    await env.clock.advance(2600)
  }

  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.state, 'complete', '历史耗尽并稳定后应判定 complete')
  assert.equal(snapshot.reachedTop, true)
  assert.ok(snapshot.batches >= 3, `应有多个 batch（实际 ${snapshot.batches}）`)

  const batchesAtComplete = snapshot.batches
  const stepsAtComplete = snapshot.steps
  const scansAtComplete = env.scanCount()
  await env.clock.advance(30_000)
  assert.equal(env.warmup.snapshot().batches, batchesAtComplete, 'complete 后不再调度 batch')
  assert.equal(env.warmup.snapshot().steps, stepsAtComplete)
  assert.equal(env.scanCount(), scansAtComplete, 'complete 后不再扫描')
})

test('W12 - max steps: 单 batch 步数不超过配置上限', async () => {
  const env = makeEnv()
  env.warmup.start()
  for (let i = 0; i < 5; i++) {
    await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + 8000)
    const snapshot = env.warmup.snapshot()
    assert.ok(
      snapshot.steps <= snapshot.batches * 2,
      `steps=${snapshot.steps} batches=${snapshot.batches}`
    )
  }
})

test('W13 - batch wall-time: 超过墙钟预算后不再增加 step', async () => {
  const env = makeEnv({ policy: { maxBatchWallTimeMs: 300, settleMs: 550 } })
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + 3000)
  const snapshot = env.warmup.snapshot()
  assert.ok(snapshot.batches >= 1)
  assert.equal(snapshot.steps, snapshot.batches, '墙钟预算 < settle 时间 → 每 batch 至多 1 步')
})

test('W14 - observer first: 每 batch 至多 1 次显式 full scan', async () => {
  const env = makeEnv()
  env.warmup.start()
  for (let i = 0; i < 4; i++) {
    env.lazyLoad(2)
    await env.clock.advance(8000)
  }
  const snapshot = env.warmup.snapshot()
  assert.ok(snapshot.batches >= 2)
  assert.ok(
    env.scanCount() <= snapshot.batches,
    `full scans (${env.scanCount()}) 不得超过 batch 数 (${snapshot.batches})`
  )
})

test('W15 - hidden tab: 页面不可见时不运行，可见后恢复', async () => {
  const env = makeEnv()
  env.setVisible(false)
  env.warmup.start()
  await env.clock.advance(
    DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + DEFAULT_HISTORY_WARMUP_POLICY.pausedRecheckMs * 2
  )
  assert.equal(env.warmup.snapshot().steps, 0)
  assert.equal(env.warmup.snapshot().pausedReason, 'hidden')

  env.setVisible(true)
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.pausedRecheckMs + DEFAULT_HISTORY_WARMUP_POLICY.settleMs * 3)
  assert.ok(env.warmup.snapshot().steps >= 1)
})

test('W16 - 已在视觉顶部且无更多历史 → 直接 complete（零 batch）', async () => {
  const env = makeEnv({ initialScrollTop: 0 })
  env.warmup.start()
  await env.clock.advance(DEFAULT_HISTORY_WARMUP_POLICY.initialIdleMs + 100)
  const snapshot = env.warmup.snapshot()
  assert.equal(snapshot.state, 'complete')
  assert.equal(snapshot.reachedTop, true)
  assert.equal(snapshot.batches, 0)
  assert.equal(snapshot.steps, 0)
})

test('W17 - 无收获连击达到上限 → 休眠不空转（规格 #11）', async () => {
  const env = makeEnv({ totalTurns: 24, mountedTurns: 24, initialScrollTop: 100000 })
  // scrollHeight 只有 6000 → clamp 后实际停在 extent；全部已挂载且无 lazy →
  // 内容无增长；位置前沿推进有限，连续无内容收获达到上限后应休眠
  env.warmup.start()
  let dormant = false
  for (let round = 0; round < 120; round++) {
    await env.clock.advance(3000)
    const snapshot = env.warmup.snapshot()
    if (snapshot.state === 'paused' && snapshot.pausedReason === null) {
      dormant = true
      break
    }
    if (snapshot.state === 'complete') break
  }
  const snapshot = env.warmup.snapshot()
  assert.ok(
    dormant || snapshot.state === 'complete',
    `应休眠或完成，实际 ${snapshot.state}/${snapshot.pausedReason}`
  )
  if (dormant) {
    const batches = snapshot.batches
    await env.clock.advance(60_000)
    assert.equal(env.warmup.snapshot().batches, batches, '休眠后不得继续 batch')
  }
})

// ---------- 目录加载状态标记（规格 #29：detached ≠ 未加载） ----------

test('badge: turnLoadFlag 区分 preview-only / not-loaded / 已完整收获', async () => {
  const { turnLoadFlag } = await import('../../src/ui/outline.ts')

  // preview：缓存 hydrate 的截断文本（无论是否挂载）→ 仅预览
  const previewTurn = makeTurn('q1', 0, '预览文本')
  previewTurn.user!.contentCompleteness = 'preview'
  assert.equal(turnLoadFlag(previewTurn), 'preview-only')

  // full + detached：正文已完整收获 → 不显示任何标记
  const fullDetached = makeTurn('q2', 1, '完整文本')
  fullDetached.user!.contentCompleteness = 'full'
  assert.equal(turnLoadFlag(fullDetached), null)

  // full + mounted → null
  const fullMounted = makeTurn('q3', 2, '完整文本')
  fullMounted.user!.contentCompleteness = 'full'
  fullMounted.user!.element = fakeElement(true)
  assert.equal(turnLoadFlag(fullMounted), null)

  // 无完整度记录且未挂载（保守兜底）→ 未加载
  const unknownDetached = makeTurn('q4', 3, '文本')
  assert.equal(turnLoadFlag(unknownDetached), 'not-loaded')

  // assistant-only turn → null
  const assistantOnly = makeTurn('q5', 4, '文本')
  assistantOnly.user = undefined
  assert.equal(turnLoadFlag(assistantOnly), null)
})

// ---------- Coverage / 快照 / 文案（规格 #30/#47/#87） ----------

test('coverage: computeHistoryCoverage 统计 full / preview / missing assistant', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const mounted = liveTurn('q1', '完整问题')
  store.messages.set('q1', {
    id: 'q1',
    role: 'user',
    text: '完整问题',
    turnIndex: 0,
    element: mounted.user!.element,
    firstSeenAt: 0,
    isMounted: true,
    contentCompleteness: 'full'
  })
  store.messages.set('q2', {
    id: 'q2',
    role: 'user',
    text: '预览问题',
    turnIndex: 1,
    element: undefined,
    firstSeenAt: 0,
    isMounted: false,
    contentCompleteness: 'preview'
  })
  store.turns = [
    {
      id: 'q1',
      index: 0,
      user: store.messages.get('q1'),
      assistant: {
        id: 'q1-a',
        role: 'assistant',
        text: '回答',
        turnIndex: 0,
        element: mounted.assistant!.element,
        firstSeenAt: 0,
        isMounted: true,
        contentCompleteness: 'full'
      },
      title: 'q1',
      preview: ''
    },
    { id: 'q2', index: 1, user: store.messages.get('q2'), title: 'q2', preview: '' }
  ]

  const coverage = computeHistoryCoverage(store, false)
  assert.equal(coverage.indexedTurns, 2)
  assert.equal(coverage.fullUserTurns, 1)
  assert.equal(coverage.previewUserTurns, 1)
  assert.equal(coverage.fullAssistantTurns, 1)
  assert.equal(coverage.missingAssistantTurns, 1)
  assert.equal(coverage.confidence, 'partial')

  const complete = computeHistoryCoverage(store, true)
  assert.equal(complete.confidence, 'partial', '仍有 preview → 不得报告 complete')

  const empty = computeHistoryCoverage(new ConversationStore(), true)
  assert.equal(empty.confidence, 'unknown')
})

test('snapshot: 纯数字快照不包含任何正文 / turn ID', () => {
  const env = makeEnv()
  const json = JSON.stringify(env.warmup.snapshot())
  assert.ok(!json.includes('问题'), '快照不得包含 turn 正文')
  assert.ok(!json.includes('q1'), '快照不得包含 turn ID')
  assert.deepEqual(Object.keys(env.warmup.snapshot()).sort(), [
    'batches',
    'discoveredTurns',
    'fullAssistantTurns',
    'fullUserTurns',
    'missingAssistantTurns',
    'pausedReason',
    'previewUserTurns',
    'reachedTop',
    'state',
    'steps'
  ])
})

test('文案: warmupStatusText 低干扰语义（规格 #47/#87）', () => {
  const env = makeEnv()
  env.warmup.start()
  const scheduled = env.warmup.snapshot()
  assert.match(warmupStatusText(scheduled) ?? '', /历史：补全中/)

  assert.equal(
    warmupStatusText({ ...scheduled, state: 'paused', pausedReason: 'user-active' }),
    null,
    'paused 维持原文案（不闪烁）'
  )

  const complete = { ...scheduled, state: 'complete' as const, reachedTop: true }
  assert.equal(warmupStatusText(complete), '历史：已尽量补全')

  assert.equal(warmupStatusText({ ...scheduled, state: 'stopped' }), '')
})

// ---------- completeness 合同（规格 #56/#57/#85：virtualization 不降级） ----------

test('合同: 已完整收获的 turn 被 virtualization 卸载后不降级、正文保留', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const turn = liveTurn('q1', '完整问题正文')
  const provider = fakeProvider([turn])
  const indexer = new ConversationIndexer(provider, store)

  indexer.scan()
  assert.equal(store.turns.length, 1)
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full')

  // virtualization 卸载：元素断连
  const disconnect = (el: FakeElementLike | undefined): void => {
    if (el) el.isConnected = false
  }
  disconnect(turn.root as FakeElementLike)
  disconnect(turn.user!.element as FakeElementLike)
  disconnect(turn.assistant!.element as FakeElementLike)
  indexer.scan()

  assert.equal(store.turns.length, 1, 'metadata 必须保留（detached）')
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full', 'full 不得降级')
  assert.equal(store.turns[0]!.user?.text, '完整问题正文', '正文必须保留')
  assert.equal(store.turns[0]!.assistant?.text, '完整问题正文 的回答')
})

test('合同: 卸载后重挂载 → full 保持、正文不丢失', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const turn = liveTurn('q1', '完整问题正文')
  const provider = fakeProvider([turn])
  const indexer = new ConversationIndexer(provider, store)

  const setConnected = (value: boolean): void => {
    for (const el of [turn.root, turn.user!.element, turn.assistant!.element]) {
      ;(el as FakeElementLike).isConnected = value
    }
  }

  indexer.scan()
  setConnected(false)
  indexer.scan()
  setConnected(true)
  indexer.scan()

  assert.equal(store.turns.length, 1)
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full')
  assert.equal(store.turns[0]!.user?.text, '完整问题正文')
})

test('合同: 缓存 preview → live 重挂载升级为 full（规格 #85）', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const hydrated = hydrateCachedConversation(store, makeCached('conv-1', ['q1', 'q2']))
  assert.equal(hydrated, 2)
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'preview')

  const turn1 = liveTurn('q1', 'q1 的完整提问')
  const turn2 = liveTurn('q2', 'q2 的完整提问')
  const provider = fakeProvider([turn1, turn2])
  const indexer = new ConversationIndexer(provider, store)
  indexer.scan(true)

  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full', 'Live 重解析后必须升级 full')
  assert.equal(store.turns[0]!.user?.text, 'q1 的完整提问')
  assert.equal(store.turns[1]!.user?.contentCompleteness, 'full')
})

test('合同: assistant 原缺失 → 收获后 attach 且为 full（规格 #85）', () => {
  const store = new ConversationStore()
  store.reset('conv-1')

  const userOnly = liveTurn('q1', '问题')
  const full = liveTurn('q1', '问题')
  // 两个阶段共用同一 turn root / user 元素身份，assistant 第二阶段才出现
  let current: LocatedTurn[] = [
    { id: 'q1', root: userOnly.root, user: userOnly.user }
  ]
  const provider: ChatProvider = {
    ...fakeProvider([]),
    locateTurns: () => current
  }
  const indexer = new ConversationIndexer(provider, store)
  indexer.scan()
  assert.ok(store.turns[0]!.assistant === undefined, '首阶段 assistant 缺失')

  current = [full]
  indexer.scan()

  const turnAfter = store.turns[0]!
  const assistant = turnAfter.assistant as ConversationMessage | undefined
  if (!assistant) throw new Error('assistant 必须被 attach')
  assert.equal(assistant.contentCompleteness, 'full')
  assert.equal(assistant.text, '问题 的回答')
})

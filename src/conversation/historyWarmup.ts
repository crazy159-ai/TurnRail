import type { ChatProvider } from '../providers/types'
import type { ConversationIndexer } from './indexer'
import type { ConversationStore } from './store'
import {
  captureScrollAnchor,
  restoreScrollAnchor,
  type ScrollAnchor
} from '../navigation/scrollAnchor'
import { isAtVisualTop, moveTowardVisualTop } from '../navigation/scrollGeometry'
import { perf } from '../utils/performance'
import type { UserActivityMonitor } from '../content/userActivity'

/**
 * Cooperative Background History Warmup（规格 #2/#7/#8/#43）。
 *
 * 目标是 History Coverage（已收获的完整正文），不是 DOM Mount Coverage：
 * ChatGPT virtualization 会继续卸载 turn，warmup 的价值在于让更多 turn
 * 在本页面生命周期内被完整读取一次（Store metadata 常驻）。
 *
 * 硬性不变量（规格 #13/#19/#21/#22）：
 * - 用户操作 / 用户导航 / streaming / manual capture / recover 全部优先于 warmup；
 * - 每个 batch 只做极少量工作（≤2 个小步 + ≤1 次扫描），随后完全让出主线程；
 * - batch 中断于用户活动时绝不恢复旧 anchor（用户位置优先）；
 * - 不调用任何网络接口，只滚动并观察 ChatGPT 已有 DOM 的 lazy loading。
 */

export type HistoryWarmupState =
  | 'idle'
  | 'scheduled'
  | 'warming'
  | 'paused'
  | 'complete'
  | 'stopped'

export type HistoryWarmupPauseReason =
  | 'user-active'
  | 'assistant-streaming'
  | 'manual-capture'
  | 'recover'
  | 'route-change'
  | 'hidden'
  | null

/** 初始工程默认值（规格 #10）：不是产品标准，防退化的第一版基线 */
export interface HistoryWarmupPolicy {
  /** 路由就绪后首个 batch 前的初始等待（让 bootstrap / 首渲染 / hydrate 先稳定） */
  initialIdleMs: number
  /** 用户必须空闲的时长 */
  userIdleMs: number
  /** 单 batch 最多移动步数 */
  maxStepsPerBatch: number
  /** 每步滚动距离（viewport 比例；比 manual capture 的 0.9 更小） */
  stepViewportRatio: number
  /** 每步滚动后等待懒加载的稳定时间 */
  settleMs: number
  /** 有收获时的下一批冷却 */
  productiveCooldownMs: number
  /** 无收获时的下一批冷却（动态退避，规格 #11） */
  unproductiveCooldownMs: number
  /** 单 batch 最大墙钟时间（双重限制之一，规格 #40） */
  maxBatchWallTimeMs: number
  /** assistant 流式输出静默多久后才允许 warmup（规格 #16） */
  streamingQuietMs: number
  /** 视觉顶部 + 连续多少轮 top 无新增才判定 complete（规格 #12，保守） */
  topStableRoundsNeeded: number
  /** paused 时的重检间隔（纯时间戳检查，零 DOM 工作） */
  pausedRecheckMs: number
  /** 连续无收获 batch 上限：超过后进入休眠（不空转，规格 #11） */
  maxUnproductiveStreak: number
}

export const DEFAULT_HISTORY_WARMUP_POLICY: HistoryWarmupPolicy = {
  initialIdleMs: 5000,
  userIdleMs: 2500,
  maxStepsPerBatch: 2,
  stepViewportRatio: 0.5,
  settleMs: 550,
  productiveCooldownMs: 2500,
  unproductiveCooldownMs: 8000,
  maxBatchWallTimeMs: 1800,
  streamingQuietMs: 1800,
  topStableRoundsNeeded: 2,
  pausedRecheckMs: 1000,
  maxUnproductiveStreak: 6
}

/**
 * History Coverage（规格 #30）：content completeness + reachedTop 证据。
 * confidence='complete' 仅表示 warmup 已确认到达当前会话视觉顶部且稳定无更多旧 turn，
 * 绝不表示模型 context / OpenAI 服务端数据完整。
 */
export interface HistoryCoverage {
  indexedTurns: number
  fullUserTurns: number
  previewUserTurns: number
  fullAssistantTurns: number
  missingAssistantTurns: number
  reachedTop: boolean
  confidence: 'complete' | 'partial' | 'unknown'
}

export function computeHistoryCoverage(
  store: ConversationStore,
  reachedTop: boolean
): HistoryCoverage {
  const userTurns = store.turns.filter((turn) => turn.user)
  const previewUserTurns = userTurns.filter(
    (turn) => turn.user?.contentCompleteness === 'preview'
  ).length
  const withAssistant = userTurns.filter((turn) => turn.assistant)
  const fullAssistantTurns = withAssistant.filter(
    (turn) => turn.assistant?.contentCompleteness !== 'preview'
  ).length

  let confidence: HistoryCoverage['confidence']
  if (userTurns.length === 0) confidence = 'unknown'
  else if (reachedTop && previewUserTurns === 0) confidence = 'complete'
  else confidence = 'partial'

  return {
    indexedTurns: store.turns.length,
    fullUserTurns: userTurns.length - previewUserTurns,
    previewUserTurns,
    fullAssistantTurns,
    missingAssistantTurns: userTurns.length - withAssistant.length,
    reachedTop,
    confidence
  }
}

/** 供 UI / Diagnostics 消费的纯数字快照（无任何正文，规格 #8/#49） */
export interface HistoryWarmupSnapshot {
  state: HistoryWarmupState
  discoveredTurns: number
  fullUserTurns: number
  previewUserTurns: number
  fullAssistantTurns: number
  missingAssistantTurns: number
  batches: number
  steps: number
  reachedTop: boolean
  pausedReason: HistoryWarmupPauseReason
}

/** 可注入计时器（单元测试用假时钟；生产走 window） */
export interface WarmupTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

function defaultWarmupTimers(): WarmupTimers {
  return {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number)
  }
}

export interface HistoryWarmupDeps {
  provider: ChatProvider
  indexer: ConversationIndexer
  store: ConversationStore
  activity: UserActivityMonitor
  isCaptureRunning(): boolean
  isRecoverRunning(): boolean
  /** 当前路由 generation（bootstrap 递增；batch 全程校验，规格 #42） */
  getGeneration(): number
  /** 页面可见性（默认 document.visibilityState === 'visible'，规格 #38） */
  isVisible?(): boolean
  policy?: Partial<HistoryWarmupPolicy>
  timers?: WarmupTimers
  now?(): number
  /** 状态 / 计数变化通知（每个 batch 至多一次 + 状态变化时；低干扰，规格 #47/#48） */
  onStateChange?(snapshot: HistoryWarmupSnapshot): void
}

export interface HistoryWarmupController {
  /** 路由就绪后调用：重置本轮计数并排定首个 batch */
  start(): void
  /** 停止并取消全部定时器（路由切换 / 永久停止） */
  stop(): void
  /** 外部暂停（程序化；batch 内部中断走各自的 paused 路径） */
  pause(reason: HistoryWarmupPauseReason): void
  /** 排定下一 batch；缺省延迟按最近一次 batch 是否有收获决定 */
  schedule(delayMs?: number): void
  snapshot(): HistoryWarmupSnapshot
}

/** 最前端签名辅助：首个已挂载 turn（= captureFullHistory 语义的 top turn） */
function firstMountedTopTurnId(store: ConversationStore): string | undefined {
  return store.firstMountedTurn()?.id
}

export function createHistoryWarmupController(
  deps: HistoryWarmupDeps
): HistoryWarmupController {
  const policy: HistoryWarmupPolicy = { ...DEFAULT_HISTORY_WARMUP_POLICY, ...deps.policy }
  const timers = deps.timers ?? defaultWarmupTimers()
  const now = deps.now ?? (() => performance.now())
  const isVisible = deps.isVisible ?? (() => document.visibilityState === 'visible')
  const { provider, indexer, store, activity } = deps

  let state: HistoryWarmupState = 'idle'
  let pausedReason: HistoryWarmupPauseReason = null
  let timer: unknown = null

  // 本轮路由的计数（start() 重置）
  let turnsAtStart = 0
  let batches = 0
  let steps = 0
  let reachedTop = false
  let topStableRounds = 0
  let lastTopTurnId: string | undefined
  let lastProductive = true

  /**
   * 会话级阅读 anchor：complete 时恢复到该位置（规格 #19/B6 —— "最终恢复同一阅读锚点"）。
   * batch 之间不恢复 —— restore 的 delta 语义是"回到捕获位置"，逐 batch 恢复会把
   * 探索进度整体抵消（normal 与 column-reverse 皆然）；探索位置必须在 batch 间持续。
   * 用户活动后重新捕获（恢复目标始终是用户最近的有意位置）；用户中断绝不覆盖用户位置。
   */
  let sessionAnchor: ScrollAnchor | null = null
  /** 探索前沿：本会话到达过的最小 scrollTop（"到过更深处"也算收获，驱动短冷却） */
  let frontierScrollTop: number | null = null
  let unproductiveStreak = 0
  /** 上一个 batch 结束时的 activity epoch：判断 batch 之间用户是否活动过 */
  let epochAtLastBatchEnd = 0

  function clearTimer(): void {
    if (timer !== null) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      timers.setTimeout(resolve, ms)
    })
  }

  /** 门控失败时仅在状态真正变化时通知 UI（低干扰） */
  function emitIfChanged(previous: HistoryWarmupState): void {
    if (state !== previous) deps.onStateChange?.(snapshot())
  }

  /**
   * 是否还有 warmup 价值：不在视觉顶部（上方可能有更旧历史）。
   * 已在顶部时无法再向旧历史移动 —— 无论是否残留 preview turn 都判定无事可做
   *（preview 升级依赖 ChatGPT 重挂载，由常规 Observer 管道收获，不归 warmup）。
   */
  function hasWarmupOpportunity(container: HTMLElement): boolean {
    return !isAtVisualTop(container)
  }

  /** 当前门控：返回暂停原因；null = 全部通过（规格 #13/#16/#17/#18/#37/#38） */
  function currentPauseReason(): HistoryWarmupPauseReason {
    if (deps.isCaptureRunning()) return 'manual-capture'
    if (deps.isRecoverRunning()) return 'recover'
    if (activity.msSinceLastAssistantStream() < policy.streamingQuietMs)
      return 'assistant-streaming'
    if (activity.msSinceLastUserActivity() < policy.userIdleMs) return 'user-active'
    if (activity.msSinceLastComposerInput() < policy.userIdleMs) return 'user-active'
    if (!isVisible()) return 'hidden'
    return null
  }

  function scheduleRun(delayMs: number): void {
    clearTimer()
    const previous = state
    state = 'scheduled'
    const gen = deps.getGeneration()
    timer = timers.setTimeout(() => {
      timer = null
      // 迟到的调度回调：generation 已变 = 路由已切换，绝不触碰新会话（规格 #42）
      if (gen !== deps.getGeneration()) return
      if (state !== 'scheduled') return
      runGateThenBatch()
    }, delayMs)
    emitIfChanged(previous)
  }

  function scheduleRecheck(): void {
    clearTimer()
    const gen = deps.getGeneration()
    timer = timers.setTimeout(() => {
      timer = null
      if (gen !== deps.getGeneration()) return
      if (state !== 'paused') return
      runGateThenBatch()
    }, policy.pausedRecheckMs)
  }

  function runGateThenBatch(): void {
    const reason = currentPauseReason()
    if (reason !== null) {
      const previous = state
      pausedReason = reason
      state = 'paused'
      perf.warmupPause()
      scheduleRecheck()
      emitIfChanged(previous)
      return
    }
    pausedReason = null
    void runBatch()
  }

  async function runBatch(): Promise<void> {
    const container = provider.getScrollContainer()
    if (!container) {
      // root / 滚动容器尚未就绪（启动窗口期）：不算 pause，稍后重试
      scheduleRun(policy.pausedRecheckMs)
      return
    }
    if (!hasWarmupOpportunity(container)) {
      // 已在视觉顶部：旧历史已全部在 DOM 证据范围内 → 会话结束并归还阅读位置
      reachedTop = true
      clearTimer()
      if (sessionAnchor) restoreScrollAnchor(provider, store, sessionAnchor)
      sessionAnchor = null
      const previous = state
      state = 'complete'
      emitIfChanged(previous)
      return
    }

    const previousState = state
    state = 'warming'
    emitIfChanged(previousState)

    const gen = deps.getGeneration()
    const epochAtStart = activity.getActivityEpoch()
    const startedAt = now()
    // 会话 anchor 在移动前捕获（生产环境 warmup 启动时启动扫描早已填充 Store；
    // Store 尚空时留空，后续 batch 再试）。batch 之间发生过用户活动时重新捕获 ——
    // 恢复目标始终是"用户最近的有意阅读位置"（规格 #19/#20 的 anchor ownership）
    if (sessionAnchor === null || epochAtStart !== epochAtLastBatchEnd) {
      sessionAnchor = captureScrollAnchor(provider, store)
    }
    const baselineTurns = store.turns.length
    const baselineTopId = firstMountedTopTurnId(store)
    const stepSize = Math.max(160, Math.floor(container.clientHeight * policy.stepViewportRatio))

    let batchSteps = 0
    let interrupted: HistoryWarmupPauseReason | null = null
    let routeChanged = false

    for (let i = 0; i < policy.maxStepsPerBatch; i++) {
      if (deps.getGeneration() !== gen) {
        routeChanged = true
        break
      }
      const reason = currentPauseReason()
      if (reason !== null) {
        interrupted = reason
        break
      }
      if (now() - startedAt >= policy.maxBatchWallTimeMs) break

      // 程序化滚动声明持有窗口：自己的 scroll 事件不算用户活动（规格 #13）
      activity.markProgrammaticScroll(policy.settleMs + 250)
      moveTowardVisualTop(container, stepSize)
      batchSteps++

      await delay(policy.settleMs)

      if (deps.getGeneration() !== gen) {
        routeChanged = true
        break
      }
      // 用户在等待期间活动 → 立即停止，本步之后不再继续（规格 #41）
      if (activity.getActivityEpoch() !== epochAtStart) {
        interrupted = 'user-active'
        break
      }
    }

    // ---- 路由已切换：静默退出 —— 不 scan、不 restore、不通知新会话（规格 #42）----
    if (routeChanged) {
      clearTimer()
      state = 'stopped'
      pausedReason = null
      sessionAnchor = null
      return
    }

    batches++
    steps += batchSteps

    if (interrupted !== null) {
      // 用户 / streaming / capture / recover 中断（规格 #13/#19）：
      // 绝不 restore —— 用户位置优先；frontier / 会话状态保留，条件恢复后继续
      perf.warmupBatch(now() - startedAt, batchSteps, false)
      perf.warmupPause()
      pausedReason = interrupted
      state = 'paused'
      emitIfChanged('warming')
      scheduleRecheck()
      return
    }

    // ---- 正常收尾：每 batch 至多 1 次 correctness sweep（规格 #23/#24/#52）----
    indexer.scan()

    const topId = firstMountedTopTurnId(store)
    const foundNewTop = topId !== undefined && topId !== baselineTopId
    // 到达过更小的 scrollTop（更深的历史方向）同样算收获：懒加载滞后时
    // 位置前沿先于 turn 增长，避免重探索已到区域被误判为空转
    const reachedNewFrontier =
      frontierScrollTop === null || container.scrollTop < frontierScrollTop
    if (reachedNewFrontier) frontierScrollTop = container.scrollTop
    const productive =
      store.turns.length > baselineTurns || foundNewTop || (batchSteps > 0 && reachedNewFrontier)
    if (store.turns.length > baselineTurns) {
      perf.warmupDiscovered(store.turns.length - baselineTurns)
    }
    perf.warmupBatch(now() - startedAt, batchSteps, productive)

    // complete 判定（保守，规格 #12）：视觉顶部 + 连续若干轮 top 无新增。
    // 注意必须在任何位置恢复之前读取 —— 判定的是 batch 的实际探测位置
    const atTop = isAtVisualTop(container)
    if (topId !== undefined && topId === lastTopTurnId && atTop) {
      topStableRounds++
    } else {
      topStableRounds = 0
    }
    lastTopTurnId = topId

    // 无收获连击上限：休眠（不空转，规格 #11）；外部 schedule() / 路由变化可唤醒
    if (!productive) unproductiveStreak++
    else unproductiveStreak = 0

    epochAtLastBatchEnd = activity.getActivityEpoch()

    if (atTop && topStableRounds >= policy.topStableRoundsNeeded) {
      reachedTop = true
      clearTimer()
      state = 'complete'
      // 会话结束：把阅读位置还给用户（规格 #19/B6）。全程无用户活动才会走到这里，
      // 同步段内 epoch 不可能变化（无 await），不存在覆盖用户新位置的可能
      if (sessionAnchor) restoreScrollAnchor(provider, store, sessionAnchor)
      sessionAnchor = null
      emitIfChanged('warming')
      return
    }

    if (!productive && unproductiveStreak >= policy.maxUnproductiveStreak) {
      clearTimer()
      pausedReason = null
      state = 'paused'
      emitIfChanged('warming')
      return
    }

    lastProductive = productive
    scheduleRun(productive ? policy.productiveCooldownMs : policy.unproductiveCooldownMs)
  }

  function snapshot(): HistoryWarmupSnapshot {
    const coverage = computeHistoryCoverage(store, reachedTop)
    return {
      state,
      discoveredTurns: Math.max(0, coverage.indexedTurns - turnsAtStart),
      fullUserTurns: coverage.fullUserTurns,
      previewUserTurns: coverage.previewUserTurns,
      fullAssistantTurns: coverage.fullAssistantTurns,
      missingAssistantTurns: coverage.missingAssistantTurns,
      batches,
      steps,
      reachedTop,
      pausedReason: state === 'paused' ? pausedReason : null
    }
  }

  return {
    start(): void {
      clearTimer()
      state = 'idle'
      pausedReason = null
      turnsAtStart = store.turns.length
      batches = 0
      steps = 0
      reachedTop = false
      topStableRounds = 0
      lastTopTurnId = undefined
      lastProductive = true
      sessionAnchor = null
      frontierScrollTop = null
      unproductiveStreak = 0
      epochAtLastBatchEnd = activity.getActivityEpoch()
      scheduleRun(policy.initialIdleMs)
    },

    stop(): void {
      clearTimer()
      state = 'stopped'
      pausedReason = null
      sessionAnchor = null
      deps.onStateChange?.(snapshot())
    },

    pause(reason: HistoryWarmupPauseReason): void {
      if (state === 'complete' || state === 'stopped') return
      clearTimer()
      const previous = state
      pausedReason = reason
      state = 'paused'
      perf.warmupPause()
      scheduleRecheck()
      emitIfChanged(previous)
    },

    schedule(delayMs?: number): void {
      if (state === 'complete' || state === 'stopped') return
      scheduleRun(delayMs ?? (lastProductive ? policy.productiveCooldownMs : policy.unproductiveCooldownMs))
    },

    snapshot
  }
}

/**
 * warmup 状态 → footer 低干扰文案（规格 #47/#48/#87）。
 * 返回 null = 维持现状（paused 不闪烁）；'' = 清空。
 * 文案绝不声称"已加载全部上下文 / 100% context"。
 */
export function warmupStatusText(snapshot: HistoryWarmupSnapshot): string | null {
  if (snapshot.state === 'warming' || snapshot.state === 'scheduled') {
    return `历史：补全中 · ${snapshot.fullUserTurns + snapshot.previewUserTurns}`
  }
  if (snapshot.state === 'complete') {
    return snapshot.reachedTop ? '历史：已尽量补全' : ''
  }
  if (snapshot.state === 'stopped') return ''
  return null
}

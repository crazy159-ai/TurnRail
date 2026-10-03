import type { ChatProvider } from '../providers/types'

/**
 * Conversation Transition Gate（会话切换 DOM 就绪门）。
 *
 * 路由身份已变 ≠ 新会话 DOM 已就绪：真实 ChatGPT 中 URL 先行，React 延后
 * 0~数百 ms 才替换 thread DOM（B20）。在这个窗口里挂 Observer / 扫描会把
 * A 会话仍挂载的内容写进 B 会话 Store（跨会话污染，规格 #15/#26）。
 *
 * 职责只有一件事（规格 #16）：
 *
 *   route changed → 等到"可安全接受新 DOM"的签名证据 → signal ready
 *
 * 证据 = 廉价 DOM 签名（root 身份 + 首 / 尾 turn 稳定 ID，规格 #19）：
 * - root 替换 → ready；
 * - root 复用但首 / 尾 turn 变化（React 原地换内容，规格 #21）→ ready；
 * - 旧签名缺失（首次挂载 / 原本无 root）→ root 出现即 ready；
 * - 空对话（0 turn）适用同一规则，绝不等待 turnCount > 0（规格 #22）。
 *
 * probe 只允许 provider.getConversationRoot() / locateTurnRoots() 级别的廉价
 * 读取（规格 #23），禁止 parseTurn(includeText) / indexer.scan / Health /
 * Handoff —— 直到 ready 为止。
 *
 * 最终确定性恢复（VALID_NEW_DOM_EVENTUALLY_APPEARS → TRANSITION_EVENTUALLY_READY）：
 * 短生命周期（规格 #24/#53）：0/16/50/100/200/400/800ms 退避探测；耗尽后
 * 绝不强把旧 DOM 当新 DOM，也不会进入永久死等 —— 转入三路并存的事件恢复：
 *   1. Mutation Wake —— 仅 transition 存活期间的临时 document.body 观察器
 *      （microtask 合并，一帧至多一次 probe），DOM 终于换上新会话时立即就绪；
 *   2. 低频 Recovery Poll（默认 1500ms，仅 transitioning 期间）—— 即使
 *      observer 未捕获目标变化也保证最终发现（只做廉价签名 probe）；
 *   3. focus / visibilitychange(visible) / RootWatch probeNow 事件恢复。
 * ready 后全部立即停止，绝不常驻；正确性优先于"立刻显示"（规格 #54），
 * 但绝不允许"fast 窗口耗尽 = 永久卡死"（same-root late swap P0 修复）。
 */

/** 运行时-only 新会话内容签名（纯 DOM 位置 / 稳定 ID，无正文提取） */

/** 运行时-only 新会话内容签名（纯 DOM 位置 / 稳定 ID，无正文提取） */
export interface ConversationDomSignature {
  root: HTMLElement | null
  turnCount: number
  firstTurnId: string | null
  lastTurnId: string | null
}

/** 廉价签名读取：仅 getConversationRoot + locateTurnRoots（不解析正文） */
export function readConversationDomSignature(
  provider: Pick<ChatProvider, 'getConversationRoot' | 'locateTurnRoots'>
): ConversationDomSignature {
  const root = provider.getConversationRoot()
  if (!root) return { root: null, turnCount: 0, firstTurnId: null, lastTurnId: null }
  const located = provider.locateTurnRoots()
  return {
    root,
    turnCount: located.length,
    firstTurnId: located[0]?.id ?? null,
    lastTurnId: located[located.length - 1]?.id ?? null
  }
}

function isSameDomSignature(
  a: ConversationDomSignature,
  b: ConversationDomSignature
): boolean {
  return (
    a.root === b.root &&
    a.turnCount === b.turnCount &&
    a.firstTurnId === b.firstTurnId &&
    a.lastTurnId === b.lastTurnId
  )
}

/**
 * 新会话 DOM 就绪判定（规格 #20/#21/#22）：
 * previous 为上一会话路由重置前捕获的签名（null = 初始挂载 / 原本无会话 DOM）。
 */
export function isConversationDomReady(
  previous: ConversationDomSignature | null,
  current: ConversationDomSignature
): boolean {
  if (current.root === null) return false
  if (previous === null || previous.root === null) return true
  if (current.root !== previous.root) return true
  // 同 root 原地换内容：首 / 尾稳定 turn ID 任一变化即视为新内容就绪
  return current.firstTurnId !== previous.firstTurnId || current.lastTurnId !== previous.lastTurnId
}

/** 计时器注入（单元测试假时钟；生产走 window） */
export interface TransitionTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** 恢复事件绑定注入（生产：window focus + document visibilitychange） */
export interface TransitionEvents {
  addProbeTriggers(listener: () => void): void
  removeProbeTriggers(listener: () => void): void
}

/**
 * Transition Mutation Wake（短命 DOM 唤醒源注入）。
 * 只在 transition 存活期间 subscribe（begin → ready/stop 即 unsubscribe）：
 * 生产实现是临时 MutationObserver（document.body, childList+subtree），
 * 绝不常驻 —— 与"禁止常驻 body observer"不冲突（生命周期以百 ms 计）。
 */
export interface TransitionDomEvents {
  subscribe(listener: () => void): void
  unsubscribe(listener: () => void): void
}

/**
 * 生产 Mutation Wake：观察 document.body 的 childList 变化。
 * 一次 conversation swap 可能产生大量 MutationRecord，必须合并 ——
 * microtask 内至多一次回调（无长期 timer，无 rAF 依赖）。
 * 依赖全部可注入（单元测试在 Node 无 DOM 环境验证合并语义）；
 * 默认环境下无 MutationObserver / document 时 subscribe 为 no-op，
 * 行为由单元测试注入的假 domEvents 覆盖。
 */
export interface TransitionDomEventsOptions {
  /** 观察目标（默认 document.body） */
  target?: () => Node
  /** 回调调度（默认 queueMicrotask：一帧至多一次 probe，无长期 timer） */
  schedule?: (callback: () => void) => void
  /** observer 构造注入（默认 new MutationObserver） */
  observerFactory?: (callback: () => void) => {
    observe(target: Node, options: { childList: boolean; subtree: boolean }): void
    disconnect(): void
  }
}

/** 最小 observer 接口（生产 MutationObserver 结构兼容；测试可注入假实现） */
interface TransitionDomObserver {
  observe(target: Node, options: { childList: boolean; subtree: boolean }): void
  disconnect(): void
}

export function createTransitionDomEvents(
  options?: TransitionDomEventsOptions
): TransitionDomEvents {
  let observer: TransitionDomObserver | null = null
  let listener: (() => void) | null = null
  let scheduled = false
  const flush = (): void => {
    scheduled = false
    listener?.()
  }
  return {
    subscribe(l) {
      listener = l
      if (observer) return
      const factory: ((callback: () => void) => TransitionDomObserver) | null =
        options?.observerFactory ??
        (typeof MutationObserver === 'undefined'
          ? null
          : (callback: () => void) => new MutationObserver(callback))
      if (!factory || (options?.target === undefined && typeof document === 'undefined')) {
        return
      }
      observer = factory(() => {
        if (scheduled) return
        scheduled = true
        ;(options?.schedule ?? queueMicrotask)(flush)
      })
      observer.observe(options?.target ? options.target() : document.body, {
        childList: true,
        subtree: true
      })
    },
    unsubscribe() {
      listener = null
      observer?.disconnect()
      observer = null
      scheduled = false
    }
  }
}

export interface ConversationTransitionOptions {
  /** 廉价签名探测（每次调用一次 getConversationRoot + locateTurnRoots） */
  probe(): ConversationDomSignature
  /** 就绪判定（bootstrap 注入：会话 / 非会话目标语义不同） */
  isReady(signature: ConversationDomSignature): boolean
  /** 就绪回调（只触发一次；触发后 gate 自行停止） */
  onReady(): void
  /** 退避间隔表（默认 0/16/50/100/200/400/800ms，规格 #24；首项 0 = 立即） */
  delays?: number[]
  timers?: TransitionTimers
  events?: TransitionEvents
  /** Mutation Wake 注入（默认生产实现：临时 body observer + microtask 合并） */
  domEvents?: TransitionDomEvents
  /** fast 退避耗尽后的低频恢复探测间隔 ms；0 = 停用（仅事件恢复） */
  recoveryPollMs?: number
}

/** transition 阶段（DEBUG routeLifecycle.transitionMode；纯枚举，无身份信息） */
export type TransitionMode = 'fast' | 'mutation-wait' | 'recovery-poll' | 'ready'

/** 探测统计（纯数字诊断；不含任何会话内容） */
export interface TransitionGateStats {
  mode: TransitionMode
  /** 全部路径的 probe 总次数（fast + recovery + wake + 事件 + probeNow） */
  probeCount: number
  /** 其中由 recovery poll 触发的次数 */
  recoveryProbeCount: number
  /** Mutation Wake 触发（合并后）的次数 */
  mutationWakeCount: number
}

export interface ConversationTransitionGate {
  /** 外部信号（RootWatch 发现 root 等）→ 立即补一次探测 */
  probeNow(): void
  /** 停止全部探测与事件监听（路由再次变化 / 已就绪 / bootstrap 销毁） */
  stop(): void
  /** 就绪后为 true */
  readonly ready: boolean
  /** 探测统计快照（DEBUG 诊断读取；stop 后冻结） */
  readonly stats: TransitionGateStats
}

function defaultTransitionTimers(): TransitionTimers {
  return {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number)
  }
}

function defaultTransitionEvents(): TransitionEvents {
  const onWindowFocus = (): void => listener()
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') listener()
  }
  let listener: () => void = () => undefined
  return {
    addProbeTriggers(l) {
      listener = l
      window.addEventListener('focus', onWindowFocus)
      document.addEventListener('visibilitychange', onVisibility)
    },
    removeProbeTriggers() {
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

/** 短生命周期退避表：覆盖真实 ChatGPT 的 DOM 交换窗口（规格 #24） */
export const TRANSITION_PROBE_DELAYS = [0, 16, 50, 100, 200, 400, 800]

/**
 * fast 退避耗尽后的低频恢复探测间隔（规格 #15）。
 * 只在 transitioning 期间运行；负载边界：每次仅一次廉价签名读取
 * （getConversationRoot + locateTurnRoots），1.5s 一次可接受。
 */
export const TRANSITION_RECOVERY_POLL_MS = 1500

export function beginConversationTransition(
  options: ConversationTransitionOptions
): ConversationTransitionGate {
  const delays = options.delays ?? TRANSITION_PROBE_DELAYS
  const timers = options.timers ?? defaultTransitionTimers()
  const events = options.events ?? defaultTransitionEvents()
  const domEvents = options.domEvents ?? createTransitionDomEvents()
  const recoveryPollMs = options.recoveryPollMs ?? TRANSITION_RECOVERY_POLL_MS

  let stopped = false
  let ready = false
  let scheduleIndex = 0
  let recoveryArmed = false
  let pendingHandle: unknown = null
  let probeCount = 0
  let recoveryProbeCount = 0
  let mutationWakeCount = 0

  const currentMode = (): TransitionMode => {
    if (ready) return 'ready'
    if (scheduleIndex < delays.length) return 'fast'
    return recoveryArmed ? 'recovery-poll' : 'mutation-wait'
  }

  const runProbe = (): boolean => {
    if (stopped || ready) return false
    probeCount++
    const signature = options.probe()
    if (!options.isReady(signature)) return false
    ready = true
    cleanup()
    options.onReady()
    return true
  }

  function cleanup(): void {
    if (pendingHandle !== null) {
      timers.clearTimeout(pendingHandle)
      pendingHandle = null
    }
    recoveryArmed = false
    events.removeProbeTriggers(onProbeTrigger)
    domEvents.unsubscribe(onDomMutation)
  }

  const scheduleNext = (): void => {
    if (stopped || ready) return
    if (scheduleIndex >= delays.length) {
      // 退避耗尽：不强把旧 DOM 当新 DOM，也绝不进入永久死等 ——
      // Mutation Wake（DOM 一变即探测）+ 低频 Recovery Poll 兜底
      // （规格 #15/#18：fast → slow，fast → dead 禁止）
      armRecoveryPoll()
      return
    }
    const delay = delays[scheduleIndex++]!
    pendingHandle = timers.setTimeout(() => {
      pendingHandle = null
      if (runProbe()) return
      scheduleNext()
    }, delay)
  }

  /** 低频恢复探测：链式 setTimeout（复用 TransitionTimers；stop/ready 即断链） */
  const armRecoveryPoll = (): void => {
    if (stopped || ready || recoveryArmed || recoveryPollMs <= 0) return
    recoveryArmed = true
    pendingHandle = timers.setTimeout(() => {
      pendingHandle = null
      recoveryArmed = false
      recoveryProbeCount++
      if (runProbe()) return
      scheduleRecovery()
    }, recoveryPollMs)
  }
  const scheduleRecovery = armRecoveryPoll

  const onProbeTrigger = (): void => {
    // 事件恢复路径：每次信号补一次探测；未就绪则继续等下一个信号
    runProbe()
  }

  const onDomMutation = (): void => {
    // Mutation Wake：DOM 终于变化（可能是 same-root 原地换内容）→ 立即探测。
    // 合并由 domEvents 生产实现负责（microtask，一帧至多一次）
    if (stopped || ready) return
    mutationWakeCount++
    runProbe()
  }

  events.addProbeTriggers(onProbeTrigger)
  // Mutation Wake 生命周期 = transition 生命周期（begin 订阅，ready/stop 退订）
  domEvents.subscribe(onDomMutation)
  // 首探测在 begin 时同步执行（对应退避表的 0ms 项，delays[0]）；
  // 未就绪再按 delays[1..] 退避调度
  if (!runProbe()) {
    scheduleIndex = 1
    scheduleNext()
  }

  return {
    probeNow(): void {
      runProbe()
    },
    stop(): void {
      if (stopped) return
      stopped = true
      cleanup()
    },
    get ready(): boolean {
      return ready
    },
    get stats(): TransitionGateStats {
      return {
        mode: currentMode(),
        probeCount,
        recoveryProbeCount,
        mutationWakeCount
      }
    }
  }
}

export { isSameDomSignature }


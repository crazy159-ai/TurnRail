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
 * 短生命周期（规格 #24/#53）：0/16/50/100/200/400/800ms 退避探测；耗尽后
 * 绝不强把旧 DOM 当新 DOM，转入事件恢复 —— focus / visibilitychange(visible)
 * 各补一次 probe，root 生命周期信号由 bootstrap 的 RootWatch 驱动 probeNow()。
 * ready 后立即停止，绝不常驻；正确性优先于"立刻显示"（规格 #54：超时后
 * UI 保持 empty / cache-only，由恢复信号继续驱动）。
 */

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
}

export interface ConversationTransitionGate {
  /** 外部信号（RootWatch 发现 root 等）→ 立即补一次探测 */
  probeNow(): void
  /** 停止全部探测与事件监听（路由再次变化 / 已就绪 / bootstrap 销毁） */
  stop(): void
  /** 就绪后为 true */
  readonly ready: boolean
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

export function beginConversationTransition(
  options: ConversationTransitionOptions
): ConversationTransitionGate {
  const delays = options.delays ?? TRANSITION_PROBE_DELAYS
  const timers = options.timers ?? defaultTransitionTimers()
  const events = options.events ?? defaultTransitionEvents()

  let stopped = false
  let ready = false
  let scheduleIndex = 0
  let pendingHandle: unknown = null

  const runProbe = (): boolean => {
    if (stopped || ready) return false
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
    events.removeProbeTriggers(onProbeTrigger)
  }

  const scheduleNext = (): void => {
    if (stopped || ready) return
    if (scheduleIndex >= delays.length) {
      // 退避耗尽：不强把旧 DOM 当新 DOM；转入事件恢复（focus / visibility /
      // RootWatch probeNow），由恢复信号继续驱动单次探测（规格 #54）
      return
    }
    const delay = delays[scheduleIndex++]!
    pendingHandle = timers.setTimeout(() => {
      pendingHandle = null
      if (runProbe()) return
      scheduleNext()
    }, delay)
  }

  const onProbeTrigger = (): void => {
    // 事件恢复路径：每次信号补一次探测；未就绪则继续等下一个信号
    runProbe()
  }

  events.addProbeTriggers(onProbeTrigger)
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
    }
  }
}

export { isSameDomSignature }

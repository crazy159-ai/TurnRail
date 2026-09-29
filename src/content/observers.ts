import type { ChatProvider, LocatedTurnRoot } from '../providers/types'

/**
 * 两层 Observer 架构（v1.2）：
 *
 *   Route Watcher → Root Watch（root 生命周期）→ Conversation Observer（turn 生命周期）
 *
 * RootWatch 只负责"等 conversation root 出现 / 通知 root 丢失"，不索引消息；
 * 找到 root 后立即断开 document 级监听 —— 正常状态绝不久远观察整个 document.body。
 *
 * 发现策略（v1.2.1）：
 * - Fast discovery（0~30s）：MutationObserver + 500ms 防御性轮询，root 出现即全部停止；
 * - 超时后不彻底放弃：进入低频恢复模式（默认 10s 一次 getConversationRoot()，
 *   单 querySelector 而非 full scan），并在 window focus / document visibilitychange
 *   时立即 probe 一次。root found / route change（stop）/ 扩展销毁 时立即停止恢复。
 *   绝不重新打开常驻 document.body MutationObserver。
 */

/** 可注入计时器 / 事件监听（测试用假时钟；生产走 window/document） */
export interface RootWatchTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  addWindowListener(type: string, listener: () => void): void
  removeWindowListener(type: string, listener: () => void): void
  addDocumentListener(type: string, listener: () => void): void
  removeDocumentListener(type: string, listener: () => void): void
}

export interface RootWatchOptions {
  /** 快速发现兜底轮询间隔（ms） */
  pollMs?: number
  /** 放弃快速发现前的轮询 tick 数（500ms × 60 = 30s） */
  maxTicks?: number
  /** 低频恢复探测间隔（ms）；0 = 超时后彻底放弃（旧行为） */
  recoveryProbeMs?: number
  /** 测试注入的计时器实现 */
  timers?: RootWatchTimers
}

function defaultRootWatchTimers(): RootWatchTimers {
  return {
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    addWindowListener: (type, listener) => window.addEventListener(type, listener),
    removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
    addDocumentListener: (type, listener) => document.addEventListener(type, listener),
    removeDocumentListener: (type, listener) => document.removeEventListener(type, listener)
  }
}

/**
 * 短命 root 发现观察器：root 已存在则立即回调；否则观察 document 直到 root 出现。
 * 30 秒（pollMs × maxTicks）未出现则转入低频恢复模式。返回 stop（路由切换 / 销毁时调用，
 * 同时取消恢复模式）。
 */
export function watchConversationRoot(
  provider: Pick<ChatProvider, 'getConversationRoot'>,
  onRootFound: (root: HTMLElement) => void,
  onGiveUp?: () => void,
  options: RootWatchOptions = {}
): () => void {
  const existing = provider.getConversationRoot()
  if (existing) {
    onRootFound(existing)
    return () => {}
  }

  const pollMs = options.pollMs ?? 500
  const maxTicks = options.maxTicks ?? 60
  const recoveryProbeMs = options.recoveryProbeMs ?? 10_000
  const timers = options.timers ?? defaultRootWatchTimers()

  let stopped = false
  let ticks = 0
  let observer: MutationObserver | null = null
  let fastInterval: unknown
  let recoveryInterval: unknown
  const focusProbe = (): void => probe()
  const visibilityProbe = (): void => probe()

  const check = (): void => {
    if (stopped) return
    const root = provider.getConversationRoot()
    if (root) {
      stop()
      onRootFound(root)
    }
  }
  const probe = check

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (observer) observer.disconnect()
    observer = null
    if (fastInterval !== undefined) timers.clearInterval(fastInterval)
    fastInterval = undefined
    if (recoveryInterval !== undefined) timers.clearInterval(recoveryInterval)
    recoveryInterval = undefined
    timers.removeWindowListener('focus', focusProbe)
    timers.removeDocumentListener('visibilitychange', visibilityProbe)
  }

  /** 快速发现超时：停掉 observer 与 500ms 轮询，转入低频恢复 */
  const enterRecovery = (): void => {
    if (observer) observer.disconnect()
    observer = null
    if (fastInterval !== undefined) timers.clearInterval(fastInterval)
    fastInterval = undefined
    onGiveUp?.()
    if (recoveryProbeMs > 0) {
      recoveryInterval = timers.setInterval(probe, recoveryProbeMs)
      timers.addWindowListener('focus', focusProbe)
      timers.addDocumentListener('visibilitychange', visibilityProbe)
    }
  }

  // 快速发现主引擎：ChatGPT 渲染必然产生 mutation。测试环境（Node）无 MutationObserver，
  // 由轮询兜底覆盖。
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => check())
    observer.observe(document.body, { childList: true, subtree: true })
  }

  fastInterval = timers.setInterval(() => {
    ticks++
    if (ticks > maxTicks) {
      enterRecovery()
      return
    }
    check()
  }, pollMs)

  return stop
}

/**
 * conversation root 内的 scoped 观察器：只观察 root 子树的 childList + characterData，
 * 不含 attributes。root 被替换/移除（无路由变化的罕见情况）时通知 onRootLost。
 * 返回 disconnect。
 */
export function observeConversationTurns(
  root: HTMLElement,
  onRecords: (records: MutationRecord[]) => void,
  onRootLost: () => void
): () => void {
  let stopped = false
  const observer = new MutationObserver((records) => {
    if (stopped) return
    if (!root.isConnected) {
      stop()
      onRootLost()
      return
    }
    onRecords(records)
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  const stop = (): void => {
    stopped = true
    observer.disconnect()
  }
  return stop
}

/** 供增量扫描的已知性检查等场景使用的轻量重导出（保持模块边界清晰） */
export type { LocatedTurnRoot }

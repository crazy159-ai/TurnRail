/**
 * 用户活动监视器（Background History Warmup 的门控输入，规格 #14/#15/#41）。
 *
 * 隐私与性能硬约束：
 * - handler 内只写时间戳 / 计数，绝不扫描 DOM、分析 Health、渲染 UI 或写缓存；
 * - 监听一律 capture + passive（keydown/input 无所谓 passive，保持一致）；
 * - 绝不读取 key / value / 文本内容 —— 用户按了什么、输入了什么完全不经过本模块；
 * - Warmup 等程序化滚动先 markProgrammaticScroll(holdMs) 声明持有窗口，
 *   窗口内的 scroll 事件不计为用户活动（防止 TurnRail 自己把自己暂停）。
 *
 * activityEpoch：任何真实用户活动递增。比"距上次活动的时间差"更可靠 ——
 * warmup batch 在每个 await 之后比对 epoch，一次比较即知中途是否发生过用户操作。
 */

export interface UserActivityMonitor {
  /** 真实用户信号（pointerdown / wheel / touchstart / keydown） */
  markUserActivity(): void
  /** composer 输入（input 事件；不含内容） */
  markComposerInput(): void
  /** assistant 流式输出变化（由 mutation pipeline 通知） */
  markAssistantStream(): void
  /** 程序化滚动持有窗口：窗口内的 scroll 事件不算用户活动 */
  markProgrammaticScroll(holdMs: number): void
  msSinceLastUserActivity(): number
  msSinceLastComposerInput(): number
  msSinceLastAssistantStream(): number
  getActivityEpoch(): number
  /** 挂载 document 级监听（幂等；非浏览器环境 no-op） */
  attach(): void
  /** 移除全部监听（测试 / 页面销毁用） */
  detach(): void
}

export interface UserActivityOptions {
  /** 可注入时钟（测试用）；默认 performance.now() */
  now?: () => number
}

export function createUserActivityMonitor(options: UserActivityOptions = {}): UserActivityMonitor {
  const now = options.now ?? (() => performance.now())

  // -Infinity = 从未发生过 → 距离永远视为无穷大（空闲）
  let lastUserActivityAt = Number.NEGATIVE_INFINITY
  let lastComposerInputAt = Number.NEGATIVE_INFINITY
  let lastAssistantStreamAt = Number.NEGATIVE_INFINITY
  let programmaticScrollHoldUntil = Number.NEGATIVE_INFINITY
  let activityEpoch = 0
  let attached = false

  const onUserSignal = (): void => {
    lastUserActivityAt = now()
    activityEpoch++
  }

  const onComposerInput = (): void => {
    lastComposerInputAt = now()
    activityEpoch++
  }

  const onScrollSignal = (): void => {
    // warmup / manual capture 的程序化滚动：不记为用户活动
    if (now() < programmaticScrollHoldUntil) return
    onUserSignal()
  }

  return {
    markUserActivity(): void {
      onUserSignal()
    },
    markComposerInput(): void {
      onComposerInput()
    },
    markAssistantStream(): void {
      lastAssistantStreamAt = now()
    },
    markProgrammaticScroll(holdMs: number): void {
      programmaticScrollHoldUntil = now() + Math.max(0, holdMs)
    },
    msSinceLastUserActivity(): number {
      return now() - lastUserActivityAt
    },
    msSinceLastComposerInput(): number {
      return now() - lastComposerInputAt
    },
    msSinceLastAssistantStream(): number {
      return now() - lastAssistantStreamAt
    },
    getActivityEpoch(): number {
      return activityEpoch
    },
    attach(): void {
      if (attached || typeof document === 'undefined') return
      attached = true
      const opts: AddEventListenerOptions = { capture: true, passive: true }
      document.addEventListener('pointerdown', onUserSignal, opts)
      document.addEventListener('wheel', onUserSignal, opts)
      document.addEventListener('touchstart', onUserSignal, opts)
      document.addEventListener('keydown', onUserSignal, opts)
      document.addEventListener('input', onComposerInput, opts)
      document.addEventListener('scroll', onScrollSignal, opts)
    },
    detach(): void {
      if (!attached) return
      attached = false
      const opts: AddEventListenerOptions = { capture: true, passive: true }
      document.removeEventListener('pointerdown', onUserSignal, opts)
      document.removeEventListener('wheel', onUserSignal, opts)
      document.removeEventListener('touchstart', onUserSignal, opts)
      document.removeEventListener('keydown', onUserSignal, opts)
      document.removeEventListener('input', onComposerInput, opts)
      document.removeEventListener('scroll', onScrollSignal, opts)
    }
  }
}

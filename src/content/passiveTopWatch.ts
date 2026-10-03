import { isAtVisualTop } from '../navigation/scrollGeometry'

/**
 * 被动到顶证据采集（Passive History Harvest 的 reachedTop 依据）。
 *
 * 只监听（capture/passive 的容器 scroll），绝不写入 scrollTop —— 这是
 * BACKGROUND_TASK_MUST_NOT_SCROLL 合同下的纯观察者：用户自然滚到视觉顶部、
 * 且稳定窗口内没有新的懒加载 turn 挂载时，才确认"到顶且无更多旧历史"。
 *
 * 与旧 Background Warmup 的区别：没有任何定时探索 / 程序化滚动 / batch 调度；
 * 所有计时都由用户自己的滚动事件驱动（滚动静止后的去抖确认），用户不动则零工作。
 *
 * 保守判定：懒加载通常在到达顶部后数百毫秒内挂载新 turn；确认窗口内的
 * turn 数一旦变化即重新武装，绝不抢跑。
 */

/** 可注入计时器（单元测试用假时钟；生产走 window） */
export interface TopWatchTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

function defaultTopWatchTimers(): TopWatchTimers {
  return {
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number)
  }
}

export interface PassiveTopWatchOptions {
  /** 当前滚动容器（路由切换后由 bootstrap 重新 watch；null 时为 no-op） */
  getContainer(): HTMLElement | null
  /** 当前 Store turn 数（懒加载是否仍在发生的证据） */
  getTurnCount(): number
  /** 到顶证据成立（只回调一次；此后 watch 自行停止） */
  onTopConfirmed(): void
  /** 滚动静止去抖（默认 500ms） */
  debounceMs?: number
  /** 到顶后的稳定确认窗口（默认 1500ms；窗口内 turn 数变化则重新武装） */
  settleMs?: number
  timers?: TopWatchTimers
}

export interface PassiveTopWatch {
  /** 绑定当前滚动容器（幂等；换绑时自动清理旧容器的待确认计时） */
  watch(): void
  /** 同一会话 root 暂时丢失：解绑容器并取消待确认计时（保留 confirmed 证据） */
  detach(): void
  /** 新会话身份：解绑 + 取消计时 + 清除到顶证据（confirmed 必须失效，规格 #34/#48） */
  reset(): void
  /** 兼容别名 = detach（路由切换必须使用 reset()，否则 A 的到顶证据残留到 B） */
  stop(): void
}

export function createPassiveTopWatch(options: PassiveTopWatchOptions): PassiveTopWatch {
  const debounceMs = options.debounceMs ?? 500
  const settleMs = options.settleMs ?? 1500
  const timers = options.timers ?? defaultTopWatchTimers()

  let container: HTMLElement | null = null
  let detach: (() => void) | null = null
  let debounceTimer: unknown = null
  let settleTimer: unknown = null
  /** 稳定窗口起点快照：null = 尚未开始等待确认 */
  let pendingTurnCount: number | null = null
  let confirmed = false

  function clearTimers(): void {
    if (debounceTimer !== null) {
      timers.clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (settleTimer !== null) {
      timers.clearTimeout(settleTimer)
      settleTimer = null
    }
  }

  /** 解绑并取消全部待确认计时（确认成立 / 路由切换） */
  function stopInternal(): void {
    clearTimers()
    detach?.()
    detach = null
    container = null
    pendingTurnCount = null
  }

  function onScroll(): void {
    if (confirmed) return
    // 滚动期间放弃未决确认（位置在变，证据无效），重新走静止去抖
    if (settleTimer !== null) {
      timers.clearTimeout(settleTimer)
      settleTimer = null
      pendingTurnCount = null
    }
    if (debounceTimer !== null) timers.clearTimeout(debounceTimer)
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null
      armVerification()
    }, debounceMs)
  }

  /** 滚动静止：仍在视觉顶部才开始稳定窗口 */
  function armVerification(): void {
    const sc = container
    if (!sc || confirmed) return
    if (!isAtVisualTop(sc)) {
      pendingTurnCount = null
      return
    }
    pendingTurnCount = options.getTurnCount()
    settleTimer = timers.setTimeout(() => {
      settleTimer = null
      verify()
    }, settleMs)
  }

  function verify(): void {
    const sc = container
    if (!sc || confirmed) return
    const stillAtTop = isAtVisualTop(sc)
    const stable = stillAtTop && options.getTurnCount() === pendingTurnCount
    if (stable) {
      // 用户自然停在视觉顶部 + 稳定窗口内无新懒加载 → 到顶证据成立
      confirmed = true
      stopInternal()
      options.onTopConfirmed()
      return
    }
    if (stillAtTop) {
      // 仍有懒加载陆续挂载：以新计数重新武装，继续等下一个稳定窗口
      pendingTurnCount = options.getTurnCount()
      settleTimer = timers.setTimeout(() => {
        settleTimer = null
        verify()
      }, settleMs)
    } else {
      pendingTurnCount = null
    }
  }

  return {
    watch(): void {
      if (confirmed) return
      const sc = options.getContainer()
      if (!sc) return
      if (sc === container) return
      // 换绑封板（规格 #35）：旧容器的待确认计时与计数快照不得影响新容器 ——
      // clear timers + clear pendingTurnCount + detach 旧 listener 后再绑定
      clearTimers()
      pendingTurnCount = null
      detach?.()
      container = sc
      const onScrollPassive = (): void => onScroll()
      sc.addEventListener('scroll', onScrollPassive, { passive: true })
      detach = () => sc.removeEventListener('scroll', onScrollPassive)
    },

    /** 同一会话 root 暂时丢失：解绑 + 取消计时，保留到顶证据（confirmed） */
    detach(): void {
      stopInternal()
    },

    /** 新会话身份：在 detach 基础上清除到顶证据，B 会话的采集从头开始 */
    reset(): void {
      confirmed = false
      stopInternal()
    },

    /** 兼容别名：语义 = detach（到顶证据的生命周期由 reset() 显式管理） */
    stop(): void {
      stopInternal()
    }
  }
}

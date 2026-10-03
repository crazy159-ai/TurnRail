import { routeIdentityKey, type RouteIdentity } from './routeIdentity'

/**
 * SPA 路由身份检测（跨 isolated world 可靠）：
 *
 *   Navigation API currententrychange ← 主路径（事件驱动）
 *   popstate                          ← 前进 / 后退
 *   focus / visibilitychange(visible) ← 恢复探测（后台 tab 计时器被节流，
 *                                       用户切回时立即核对身份）
 *   廉价身份轮询                      ← 兜底（Navigation API 缺席 / 失效时保证正确性）
 *
 * 为什么不再 monkey patch history.pushState：content script 运行在
 * ISOLATED world，ChatGPT 页面（MAIN world）调用 pushState 不会经过本
 * world 的 wrapper —— 旧实现"Mock 测试通过、真实 ChatGPT 更新不实时"的
 * 根因。Navigation API 的 navigation 对象随共享 session history 更新，
 * 在隔离世界同样收到 currententrychange，是浏览器原生的跨 world 信号。
 *
 * 本模块只观察（绝不 intercept()/preventDefault()/navigate()），不认识
 * /c/ 站点语义 —— 身份提取由调用方注入（readRouteIdentity + Provider）。
 * 严格去重：多来源看到同一次导航时 onChange 只触发一次
 * （nextKey === currentKey 即丢弃，核心不变量见 contract 测试 RW4）。
 */

export type RouteChangeSource =
  | 'navigation-api'
  | 'popstate'
  | 'poll'
  | 'focus'
  | 'visibility'

export interface RouteChange {
  previous: RouteIdentity
  current: RouteIdentity
  source: RouteChangeSource
}

/** 信号 / 变更计数（纯数字；DEBUG routeLifecycle 指标，见 bootstrap） */
export interface RouteWatcherMetrics {
  /** 真实路由身份变化次数（= transitions） */
  detected: number
  /** 与当前身份相同而被忽略的探测次数 */
  duplicateIgnored: number
  navigationApiSignals: number
  popstateSignals: number
  pollSignals: number
  focusSignals: number
  visibilitySignals: number
  transitions: number
}

/** 最小 Navigation API 接口：只监听，绝不调用导航方法（规格 #68） */
export interface NavigationLike extends EventTarget {}

/** 事件绑定注入（单元测试假环境；生产绑定 window / document） */
export interface RouteWatcherEvents {
  addWindowListener(type: string, listener: () => void): void
  removeWindowListener(type: string, listener: () => void): void
  addDocumentListener(type: string, listener: () => void): void
  removeDocumentListener(type: string, listener: () => void): void
}

/** 计时器注入（单元测试假时钟；生产走 window） */
export interface RouteWatcherTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface RouteWatcherOptions {
  /** 兜底轮询间隔（ms）；事件驱动可用时轮询仅作 correctness fallback（规格 #11） */
  pollMs?: number
  /** Navigation API 对象注入：undefined = 运行时 feature detect；null = 强制停用（规格 #50） */
  navigationApi?: NavigationLike | null
  events?: RouteWatcherEvents
  timers?: RouteWatcherTimers
}

/** stop() 兼容 "返回 () => void" 契约；metrics() 供 DEBUG 诊断读取计数 */
export interface RouteWatcherStop {
  (): void
  metrics(): RouteWatcherMetrics
}

function defaultRouteWatcherEvents(): RouteWatcherEvents {
  return {
    addWindowListener: (type, listener) => window.addEventListener(type, listener),
    removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
    addDocumentListener: (type, listener) => document.addEventListener(type, listener),
    removeDocumentListener: (type, listener) => document.removeEventListener(type, listener)
  }
}

function defaultRouteWatcherTimers(): RouteWatcherTimers {
  return {
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number)
  }
}

/** 运行时 feature detect：navigation 对象存在且可绑定事件才启用主路径 */
function detectNavigationApi(): NavigationLike | null {
  try {
    const candidate = (window as Window & { navigation?: NavigationLike }).navigation
    if (candidate && typeof candidate.addEventListener === 'function') return candidate
  } catch {
    // navigation 访问失败（极端环境）→ 视为缺席，轮询兜底
  }
  return null
}

const DEFAULT_POLL_MS = 300

export function createRouteWatcher(
  getIdentity: () => RouteIdentity,
  onChange: (event: RouteChange) => void,
  options?: RouteWatcherOptions
): RouteWatcherStop {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS
  const events = options?.events ?? defaultRouteWatcherEvents()
  const timers = options?.timers ?? defaultRouteWatcherTimers()
  const metrics: RouteWatcherMetrics = {
    detected: 0,
    duplicateIgnored: 0,
    navigationApiSignals: 0,
    popstateSignals: 0,
    pollSignals: 0,
    focusSignals: 0,
    visibilitySignals: 0,
    transitions: 0
  }

  let current = getIdentity()
  let stopped = false

  const probe = (source: RouteChangeSource): void => {
    if (stopped) return
    const next = getIdentity()
    const nextKey = routeIdentityKey(next)
    const currentKey = routeIdentityKey(current)
    if (nextKey === currentKey) {
      metrics.duplicateIgnored++
      return
    }
    const previous = current
    current = next
    metrics.detected++
    metrics.transitions++
    onChange({ previous, current, source })
  }

  const onNavigationApi = (): void => {
    metrics.navigationApiSignals++
    probe('navigation-api')
  }
  const onPopstate = (): void => {
    metrics.popstateSignals++
    probe('popstate')
  }
  const onPoll = (): void => {
    metrics.pollSignals++
    probe('poll')
  }
  const onFocus = (): void => {
    metrics.focusSignals++
    probe('focus')
  }
  const onVisibility = (): void => {
    // 仅在变为可见时探测（后台 → hidden 不产生路由信息）
    if (document.visibilityState !== 'visible') return
    metrics.visibilitySignals++
    probe('visibility')
  }

  // Navigation API：feature detect（规格 #50 —— 不假设 window.navigation 必然存在）
  const navigationApi =
    options?.navigationApi !== undefined ? options.navigationApi : detectNavigationApi()

  if (navigationApi) {
    navigationApi.addEventListener('currententrychange', onNavigationApi)
  }
  events.addWindowListener('popstate', onPopstate)
  events.addWindowListener('focus', onFocus)
  events.addDocumentListener('visibilitychange', onVisibility)
  // 轮询兜底永远保留（规格 #11）：Navigation API = fast path，poll = correctness fallback
  const pollHandle = timers.setInterval(onPoll, pollMs)

  const stop = ((): void => {
    if (stopped) return
    stopped = true
    timers.clearInterval(pollHandle)
    if (navigationApi) {
      navigationApi.removeEventListener('currententrychange', onNavigationApi)
    }
    events.removeWindowListener('popstate', onPopstate)
    events.removeWindowListener('focus', onFocus)
    events.removeDocumentListener('visibilitychange', onVisibility)
  }) as RouteWatcherStop

  stop.metrics = (): RouteWatcherMetrics => ({ ...metrics })
  return stop
}

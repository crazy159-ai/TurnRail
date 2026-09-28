import type { ChatProvider } from '../providers/types'
import type { ConversationStore } from '../conversation/store'
import { debounce } from '../utils/debounce'
import { isAtVisualBottom, isAtVisualTop } from './scrollGeometry'

/**
 * 阅读位置检测（scroll-spy 引擎）：
 * - 滚动容器上挂 passive scroll 监听，rAF 节流；
 * - 每个滚动帧只读一次 scrollTop，与缓存的 turn 内容偏移比较，
 *   不做逐节点 getBoundingClientRect；
 * - 偏移缓存在结构变化 / 元素重挂载 / 滚动静止时批量重建。
 *
 * 设计说明：未以 IntersectionObserver 为主引擎——以滚动容器为 root 的 IO 在
 * 部分嵌入式环境不产生任何回调（已在测试环境实测），而"缓存偏移 + scroll"
 * 在所有环境行为一致，且同样满足性能约束（无滚动帧内布局读取）。
 */
export class ScrollSpy {
  private tops = new Map<string, number>()
  private order: string[] = []
  private activeId: string | undefined
  private scrollTarget: HTMLElement | Window | null = null
  private detachScroll: (() => void) | null = null
  private pollTimer = 0
  private lastScrollTop = -1
  /** 布局漂移自检哨兵：最后一个已挂载 turn 的元素与缓存偏移 */
  private sentinel: { id: string; element: HTMLElement; contentTop: number } | null = null
  /** DEBUG：重建历史（诊断用，最多保留 10 条） */
  rebuildLog: Array<{ at: number; scrollTop: number; containerTop: number; sample: number[] }> = []

  constructor(
    private store: ConversationStore,
    private provider: ChatProvider,
    private onActiveChange: (turnId: string | undefined) => void
  ) {}

  start(): void {
    this.refresh()
  }

  /** 跳转等主动行为直接指定 active；后续滚动事件会自然接管 */
  setActiveManually(turnId: string | undefined): void {
    this.activeId = turnId
    this.onActiveChange(turnId)
  }

  stop(): void {
    this.detachScroll?.()
    this.detachScroll = null
    this.scrollTarget = null
    window.clearInterval(this.pollTimer)
    this.pollTimer = 0
    this.tops.clear()
    this.order = []
    this.activeId = undefined
    this.lastScrollTop = -1
  }

  /** turn 结构 / 元素变化后重建缓存并重新评估 */
  refresh(): void {
    this.rebuildTops()
    this.bindScrollTarget()
    this.ensurePoll()
    this.evaluateNow()
  }

  /** 批量重建偏移缓存（一次 layout，N 次读取） */
  rebuildTops(): void {
    this.tops.clear()
    this.order = []
    const container = this.provider.getScrollContainer()
    const containerRect = container?.getBoundingClientRect() ?? null
    const sample: number[] = []
    for (const turn of this.store.turns) {
      this.order.push(turn.id)
      const element = turn.user?.element
      if (!element?.isConnected) continue
      const rect = element.getBoundingClientRect()
      const contentTop =
        container && containerRect
          ? rect.top - containerRect.top + container.scrollTop
          : rect.top + window.scrollY
      if (sample.length < 4) sample.push(Math.round(contentTop))
      this.tops.set(turn.id, contentTop)
      this.sentinel = { id: turn.id, element, contentTop }
    }
    this.rebuildLog.push({
      at: Date.now(),
      scrollTop: container ? Math.round(container.scrollTop) : Math.round(window.scrollY),
      containerTop: containerRect ? Math.round(containerRect.top) : -1,
      sample
    })
    if (this.rebuildLog.length > 10) this.rebuildLog.shift()
  }

  private bindScrollTarget(): void {
    const container = this.provider.getScrollContainer()
    const target: HTMLElement | Window = container ?? window
    if (this.scrollTarget === target) return
    this.detachScroll?.()
    this.scrollTarget = target

    // 每个滚动事件直接求值：一次 scrollTop 读取 + 有序数组扫描（纯内存比较，
    // 无布局读取），200 turn 规模下开销可忽略；不用 rAF（遮挡环境下不触发）
    const onScroll = (): void => this.evaluateNow()
    // 滚动静止后重建偏移缓存（流式输出 / 懒加载可能改变布局）
    const onSettle = debounce(() => {
      if (this.order.length > 0) this.rebuildTops()
    }, 400)
    target.addEventListener('scroll', onScroll, { passive: true })
    target.addEventListener('scroll', onSettle, { passive: true })
    this.detachScroll = () => {
      target.removeEventListener('scroll', onScroll)
      onSettle.cancel()
      target.removeEventListener('scroll', onSettle)
    }
  }

  /** 兜底轮询：个别环境（如被遮挡的嵌入视图）不派发 scroll 事件。
   *  每 400ms 一次 scrollTop 读取 + 布局漂移自检，开销可忽略。 */
  private ensurePoll(): void {
    if (this.pollTimer !== 0) return
    this.lastScrollTop = -1
    this.pollTimer = window.setInterval(() => {
      const container = this.provider.getScrollContainer()
      const scrollTop = container ? container.scrollTop : window.scrollY
      const scrolled = scrollTop !== this.lastScrollTop
      this.lastScrollTop = scrollTop
      // 布局自检：初次测量可能发生在样式/布局未稳定的瞬间（实测存在于部分环境），
      // 抽验哨兵元素，漂移超过阈值则整体重建缓存
      const drifted = this.validateTops()
      if (scrolled || drifted) this.evaluateNow()
    }, 400)
  }

  /** 返回 true 表示检测到漂移并已重建 */
  private validateTops(): boolean {
    const sentinel = this.sentinel
    if (!sentinel || !sentinel.element.isConnected) return false
    const container = this.provider.getScrollContainer()
    const containerRect = container?.getBoundingClientRect() ?? null
    const rect = sentinel.element.getBoundingClientRect()
    const measured =
      container && containerRect
        ? rect.top - containerRect.top + container.scrollTop
        : rect.top + window.scrollY
    if (Math.abs(measured - sentinel.contentTop) > 2) {
      this.rebuildTops()
      return true
    }
    return false
  }

  private evaluateNow(): void {
    const container = this.provider.getScrollContainer()
    const scrollTop = container ? container.scrollTop : window.scrollY
    this.lastScrollTop = scrollTop
    const visibleHeight = container ? container.clientHeight : window.innerHeight
    const bandOffset = visibleHeight * 0.22

    let best: string | undefined
    for (const turnId of this.order) {
      const top = this.tops.get(turnId)
      if (top === undefined) continue
      if (top - scrollTop <= bandOffset) best = turnId
      else break
    }
    if (best === undefined) {
      // 无任何 turn 越过阅读带（如历史未加载时位于顶部）：取第一个已挂载 turn
      best = this.order.find((turnId) => this.tops.has(turnId))
    }

    // 边界规则（ScrollGeometry 统一判定，兼容 column-reverse 的负 scrollTop）：
    // 视觉顶部 → 第一个已挂载 turn；视觉底部 → 最后一个已挂载 turn
    const mountedIds = this.order.filter((turnId) => this.tops.has(turnId))
    if (container) {
      if (isAtVisualTop(container)) best = mountedIds[0] ?? best
      else if (isAtVisualBottom(container)) best = mountedIds[mountedIds.length - 1] ?? best
    } else {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      if (scrollTop <= 1) best = mountedIds[0] ?? best
      else if (scrollTop >= maxScroll - 4) best = mountedIds[mountedIds.length - 1] ?? best
    }

    this.applyActive(best)
  }

  private applyActive(turnId: string | undefined): void {
    if (turnId === this.activeId) return
    this.activeId = turnId
    this.onActiveChange(turnId)
  }
}

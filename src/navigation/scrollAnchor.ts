import type { ChatProvider } from '../providers/types'
import type { ConversationStore } from '../conversation/store'
import { clampScrollTop, getScrollBounds } from './scrollGeometry'

export interface ScrollAnchor {
  /** 锚定 turn（当前视口内第一个已挂载 turn） */
  turnId: string
  /** 该 turn 相对滚动容器顶部的视口偏移 */
  viewportOffset: number
  /** 捕获时的原始 scrollTop（column-reverse 下可为负，仅作兜底） */
  scrollTop: number
  scrollHeight: number
}

/**
 * 捕获当前阅读位置。用"锚定 turn + 视口偏移"而不是裸 scrollTop，
 * DOM 变化后按锚点元素的实测位移做 delta 校正，与滚动坐标方向无关。
 */
export function captureScrollAnchor(provider: ChatProvider, store: ConversationStore): ScrollAnchor | null {
  const container = provider.getScrollContainer()
  if (!container) return null
  const turn =
    store.turns.find((t) => t.user?.element?.isConnected) ??
    store.turns.find((t) => t.assistant?.element?.isConnected)
  const element = turn?.user?.element ?? turn?.assistant?.element
  if (!turn || !element) return null
  return {
    turnId: turn.id,
    viewportOffset: element.getBoundingClientRect().top - container.getBoundingClientRect().top,
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight
  }
}

/**
 * 恢复到捕获时的阅读位置（spec 第八节算法）：
 * 1. 锚点元素仍在文档中：delta = newAnchorRect.top - containerRect.top - oldViewportOffset，
 *    scrollTop += delta 后 clamp；
 * 2. 锚点已被虚拟化卸载：column-reverse 下内容向视觉顶部（远离原点）增长、
 *    原点固定，记录的 scrollTop 仍然指向同一内容，直接恢复；
 *    normal 模式下按 scrollHeight 增量补偿（仅正向坐标系使用该假设）。
 */
export function restoreScrollAnchor(
  provider: ChatProvider,
  store: ConversationStore,
  anchor: ScrollAnchor | null
): void {
  if (!anchor) return
  const container = provider.getScrollContainer()
  if (!container) return

  const turn = store.getTurn(anchor.turnId)
  const element = turn?.user?.element ?? turn?.assistant?.element

  if (element?.isConnected) {
    const containerRect = container.getBoundingClientRect()
    const delta = element.getBoundingClientRect().top - containerRect.top - anchor.viewportOffset
    if (Math.abs(delta) > 1) {
      container.scrollTop = clampScrollTop(container, container.scrollTop + delta)
    }
    return
  }

  const bounds = getScrollBounds(container)
  let target = anchor.scrollTop
  if (!bounds.reversed) {
    const delta = container.scrollHeight - anchor.scrollHeight
    if (delta > 0) target += delta
  }
  container.scrollTop = clampScrollTop(container, target)
}

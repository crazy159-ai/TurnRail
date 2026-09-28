import type { ChatProvider } from '../providers/types'
import type { ConversationTurn } from '../conversation/types'
import { clampScrollTop } from './scrollGeometry'

/** 估算 sticky header 等占位高度，使目标精确落在遮挡物下方 */
function measureHeaderOffset(container: HTMLElement | null): number {
  let offset = 0
  if (container) {
    const containerRect = container.getBoundingClientRect()
    const parent = container.parentElement
    if (parent) {
      for (const child of Array.from(parent.children)) {
        if (child === container || !(child instanceof HTMLElement)) continue
        const style = window.getComputedStyle(child)
        if (style.position !== 'sticky' && style.position !== 'fixed') continue
        const rect = child.getBoundingClientRect()
        if (rect.bottom > containerRect.top && rect.height < containerRect.height * 0.9) {
          offset = Math.max(offset, rect.bottom - containerRect.top)
        }
      }
    }
    return offset
  }
  // window 滚动场景：检查 body 顶层 fixed/sticky 元素对视口顶部的遮挡
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child.id === 'turnrail-host') continue
    const style = window.getComputedStyle(child)
    if (style.position !== 'sticky' && style.position !== 'fixed') continue
    const rect = child.getBoundingClientRect()
    if (rect.top <= 0 && rect.bottom > 0) offset = Math.max(offset, rect.bottom)
  }
  return offset
}

/** 极轻量的临时视觉脉冲：WAAPI 动画，结束自动消失，不留任何 class / 内联样式 */
function pulse(target: HTMLElement): void {
  try {
    target.animate(
      [
        { outline: '2px solid rgba(16, 163, 127, 0)', outlineOffset: '3px' },
        { outline: '2px solid rgba(16, 163, 127, 0.85)', outlineOffset: '3px', offset: 0.25 },
        { outline: '2px solid rgba(16, 163, 127, 0.85)', offset: 0.6 },
        { outline: '2px solid rgba(16, 163, 127, 0)', outlineOffset: '3px' }
      ],
      { duration: 1400, easing: 'ease-out' }
    )
  } catch {
    // 环境不支持 WAAPI 时静默降级
  }
}

/**
 * 自绘 rAF-free 缓动滚动（setTimeout 步进：遮挡/后台环境下 rAF 不触发）。
 * 终点经 clampScrollTop 归一，normal 与 column-reverse 通用；
 * 每个 tick 重新 clamp，内容增长（流式输出）时自动适应。
 */
function animateScroll(container: HTMLElement | null, from: number, to: number, durationMs = 450): void {
  const setTop = (value: number): void => {
    if (container) {
      container.scrollTop = clampScrollTop(container, value)
    } else {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo(0, Math.min(Math.max(0, value), max))
    }
  }
  const clampedTo = container
    ? clampScrollTop(container, to)
    : Math.max(0, Math.min(to, document.documentElement.scrollHeight - window.innerHeight))
  if (Math.abs(clampedTo - from) < 1) return

  const start = Date.now()
  const easeInOutCubic = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  const tick = (): void => {
    const progress = Math.min(1, (Date.now() - start) / durationMs)
    setTop(from + (clampedTo - from) * easeInOutCubic(progress))
    if (progress < 1) window.setTimeout(tick, 16)
  }
  window.setTimeout(tick, 16)
}

/**
 * 跳转到某个已挂载 turn —— delta-based 导航：
 *
 *   delta   = targetRect.top - containerRect.top - headerOffset - margin
 *   desired = container.scrollTop + delta
 *
 * 只依赖视口相对位移，不依赖滚动坐标原点，因此 normal 与 column-reverse
 * （真实 ChatGPT，scrollTop ∈ [-extent, 0]）通用。终点经 ScrollGeometry clamp。
 */
export function jumpToTurn(provider: ChatProvider, turn: ConversationTurn): boolean {
  // 导航目标优先 userUnit（user 消息单元），其次 turn 容器本身，而不是 markdown 内部某个 p
  const target = turn.user?.element ?? turn.root ?? turn.assistant?.element
  if (!target || !target.isConnected) return false

  const container = provider.getScrollContainer()
  const headerOffset = measureHeaderOffset(container)
  const margin = 10

  if (container) {
    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const delta = targetRect.top - containerRect.top - headerOffset - margin
    animateScroll(container, container.scrollTop, container.scrollTop + delta)
  } else {
    const targetRect = target.getBoundingClientRect()
    const delta = targetRect.top - headerOffset - margin
    animateScroll(null, window.scrollY, window.scrollY + delta)
  }

  pulse(target)
  return true
}

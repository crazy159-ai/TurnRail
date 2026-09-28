/**
 * 统一滚动几何层：项目内所有 scrollTop 读写 / 边界判断必须经过这里。
 *
 * 支持两种滚动坐标系：
 * - normal（column）：scrollTop ∈ [0, +extent]，0 = 视觉顶部
 * - column-reverse（真实 ChatGPT）：scrollTop ∈ [-extent, 0]，0 = 视觉底部，
 *   视觉顶部 ≈ -extent（scrollTop 为负是合法值，不是异常）
 *
 * "视觉顶/底"始终指内容的时间顺序两端：顶 = 最旧（Q1 方向），底 = 最新（QN 方向）。
 */

export interface ScrollBounds {
  reversed: boolean
  extent: number
  min: number
  max: number
}

const reversedCache = new WeakMap<HTMLElement, boolean>()

/** 容器是否为 column-reverse 反向滚动坐标系（按元素缓存，computed style 只读一次） */
export function isReversedContainer(container: HTMLElement): boolean {
  let reversed = reversedCache.get(container)
  if (reversed === undefined) {
    reversed = window.getComputedStyle(container).flexDirection === 'column-reverse'
    reversedCache.set(container, reversed)
  }
  return reversed
}

export function getScrollBounds(container: HTMLElement): ScrollBounds {
  const extent = Math.max(0, container.scrollHeight - container.clientHeight)
  const reversed = isReversedContainer(container)
  return reversed
    ? { reversed: true, extent, min: -extent, max: 0 }
    : { reversed: false, extent, min: 0, max: extent }
}

/** 把任意目标 scrollTop 夹到该容器的合法区间 */
export function clampScrollTop(container: HTMLElement, value: number): number {
  const bounds = getScrollBounds(container)
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

/** 是否位于视觉顶部（最旧内容一端） */
export function isAtVisualTop(container: HTMLElement): boolean {
  const bounds = getScrollBounds(container)
  return bounds.reversed
    ? container.scrollTop <= bounds.min + 2
    : container.scrollTop <= 2
}

/** 是否位于视觉底部（最新内容一端） */
export function isAtVisualBottom(container: HTMLElement): boolean {
  const bounds = getScrollBounds(container)
  return bounds.reversed
    ? container.scrollTop >= -2
    : container.scrollTop >= bounds.max - 2
}

/** 向视觉顶部（更旧内容）移动 step 像素；自动 clamp，不允许各处自行 Math.max(0, ...) */
export function moveTowardVisualTop(container: HTMLElement, step: number): void {
  const delta = Math.max(0, step)
  container.scrollTop = clampScrollTop(container, container.scrollTop - delta)
}

/** 向视觉底部（更新内容）移动 step 像素；自动 clamp */
export function moveTowardVisualBottom(container: HTMLElement, step: number): void {
  const delta = Math.max(0, step)
  container.scrollTop = clampScrollTop(container, container.scrollTop + delta)
}

/**
 * 元素"内容坐标"（相对内容视觉顶部的偏移），对两种坐标系统一且滚动不变：
 * contentY = elementRect.top - containerRect.top + (scrollTop - bounds.min)
 *
 * 推导：两种坐标系下 d(elementRectTop)/d(scrollTop) 均为 -1，
 * 而 d(scrollTop - min)/d(scrollTop) = +1，相加抵消，故为滚动不变量。
 */
export function getContentTop(
  container: HTMLElement,
  elementRectTop: number,
  containerRectTop: number
): number {
  const bounds = getScrollBounds(container)
  return elementRectTop - containerRectTop + (container.scrollTop - bounds.min)
}

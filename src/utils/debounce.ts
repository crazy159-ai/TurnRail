export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void
  cancel(): void
}

/** 尾沿去抖：连续调用只在静默 waitMs 后执行一次 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): DebouncedFn<A> {
  let timer: number | undefined
  const wrapped = (...args: A): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      fn(...args)
    }, waitMs)
  }
  wrapped.cancel = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
  }
  return wrapped
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

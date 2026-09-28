/** 生产默认关闭；开发时在页面控制台执行 localStorage.setItem('tn-debug','1') 开启 */
export const DEBUG: boolean = (() => {
  try {
    return globalThis.localStorage?.getItem('tn-debug') === '1'
  } catch {
    return false
  }
})()

export function debugLog(...args: unknown[]): void {
  if (!DEBUG) return
  console.debug('[TurnRail]', ...args)
}

export function debugWarn(...args: unknown[]): void {
  if (!DEBUG) return
  console.warn('[TurnRail]', ...args)
}

/** 非致命错误：只在控制台留痕，不影响页面 */
export function reportError(scope: string, err: unknown): void {
  console.warn(`[TurnRail] ${scope} 出错（不影响页面使用）`, err)
}

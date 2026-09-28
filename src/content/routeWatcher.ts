/**
 * SPA 路由变化检测：history.pushState/replaceState 钩子 + popstate + 低频轮询兜底。
 * 三者混合，任一失效仍有轮询保障。返回 cleanup（恢复被包裹的原生方法）。
 */
export function createRouteWatcher(onChange: (url: string, prevUrl: string) => void, pollMs = 800): () => void {
  let lastUrl = location.href

  const tick = (): void => {
    const current = location.href
    if (current === lastUrl) return
    const prev = lastUrl
    lastUrl = current
    onChange(current, prev)
  }

  const originalPush = history.pushState.bind(history)
  const originalReplace = history.replaceState.bind(history)

  history.pushState = function pushStateWrapper(...args: Parameters<History['pushState']>): void {
    const result = originalPush(...args)
    tick()
    return result
  }
  history.replaceState = function replaceStateWrapper(
    ...args: Parameters<History['replaceState']>
  ): void {
    const result = originalReplace(...args)
    tick()
    return result
  }

  window.addEventListener('popstate', tick)
  const timer = window.setInterval(tick, pollMs)

  return () => {
    window.clearInterval(timer)
    window.removeEventListener('popstate', tick)
    history.pushState = originalPush
    history.replaceState = originalReplace
  }
}

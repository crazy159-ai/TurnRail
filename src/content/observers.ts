import { debounce } from '../utils/debounce'

/**
 * 全局 DOM 变更监听：MutationObserver 回调内不做昂贵计算，
 * 只触发去抖后的增量扫描。返回 cleanup 函数。
 */
export function startDomObserver(onQuietMutation: () => void, debounceMs = 150): () => void {
  const debouncedScan = debounce(onQuietMutation, debounceMs)
  const observer = new MutationObserver((mutations) => {
    if (mutations.length > 0) debouncedScan()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    debouncedScan.cancel()
    observer.disconnect()
  }
}

/**
 * Cache storage 错误分类（v1.2.2 Storage Context Resilience Hotfix）。
 *
 * 只识别一种"预期生命周期异常"：Chrome 扩展重载后，旧 content script 的
 * Extension context 被销毁，任何 chrome.storage 调用都会以
 * "Extension context invalidated." reject。这是开发环境的正常现象，
 * 应安静降级到 Live-only，而不是当作 TurnRail 故障上报。
 *
 * 其余一切 storage 错误（quota / backend failure / 未知 API 错误 / 编程错误）
 * 都不属于此类，必须继续走 reportError —— 绝不泛化匹配（禁止 /extension|chrome|storage/ 这类规则）。
 */

export type CacheFailureKind = 'extension-context-invalidated' | 'storage-error'

/** 从任意 throw 值提取可读 message（Error / string / 其他值 / null 均 crash-safe） */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error ?? '')
  } catch {
    return ''
  }
}

/** 仅匹配 Chrome 明确的扩展生命周期异常文案 */
export function isExtensionContextInvalidated(error: unknown): boolean {
  return /extension context invalidated/i.test(getErrorMessage(error))
}

export function classifyCacheFailure(error: unknown): CacheFailureKind {
  return isExtensionContextInvalidated(error) ? 'extension-context-invalidated' : 'storage-error'
}

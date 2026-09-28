/** FNV-1a 32 位哈希，返回 8 位 hex */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 无 DOM 稳定 ID 时的 fallback key：
 * role + 归一化文本哈希 + 同内容出现序号。
 * 注意：纯文本重复（如连续发送"继续"）由 ordinal 区分，
 * 该策略在虚拟化卸载场景下可能出现 ordinal 漂移，属于已知限制。
 */
export function buildFallbackKey(role: string, normalizedText: string, ordinal: number): string {
  return `hash-${fnv1a(role + '\u0000' + normalizedText)}-${ordinal}`
}

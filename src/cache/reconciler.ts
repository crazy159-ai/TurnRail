/**
 * 缓存与 Live DOM 的调和辅助（纯函数）。
 *
 * 主体调和由 ConversationIndexer 既有机制完成：hydrated turn 挂载后按
 * turn.id 与 Live 消息对齐（Live 永远胜出），未挂载的缓存 turn 经 detached
 * 锚点机制保序保留 —— 这里只补充 Indexer 无法自行判断的部分：
 * 缓存与 Live 几乎无重叠时的 stale 判定（分支切换 / 编辑后 id 整体更换）。
 */

/**
 * 简单 stale 判定：已挂载 Live user turn 数量 ≥ 3 且与缓存 id 零重叠时，
 * 认为缓存来自另一条分支（edit / regenerate），不应与当前 Live 数据盲目合并。
 * 任意一侧为空时不判定为 stale（渐进加载 / 纯缓存恢复都是正常状态）。
 */
export function isLikelyStale(cachedIds: ReadonlySet<string>, liveMountedIds: readonly string[]): boolean {
  if (cachedIds.size === 0 || liveMountedIds.length < 3) return false
  return !liveMountedIds.some((id) => cachedIds.has(id))
}

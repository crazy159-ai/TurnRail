import type { ConversationStore } from '../conversation/store'
import type { ConversationTurn } from '../conversation/types'
import type { CachedConversation } from './types'

/**
 * CachedConversation → Runtime Store 的 hydrate（数据层纯操作，不触碰 DOM）。
 *
 * 恢复 turn 的 id / index / title / preview 与 user 消息 metadata；
 * element / root / assistant 一律为空 —— 这些只能来自 Live DOM，
 * 后续由 Indexer 的调和机制（detached 锚点 + 全量 reconcile）绑定。
 *
 * 防串会话：store.conversationKey 与缓存不一致时直接忽略（SPA route 隔离的
 * 最后一道防线；generation 竞态防护在 bootstrap 层完成）。
 *
 * 若 hydrate 时 store 中已有 live turn（缓存读取晚于首次扫描），按缓存顺序
 * 以"最近已存在邻居"为锚点插入，保证合并顺序与缓存一致。
 */

export function hydrateCachedConversation(
  store: ConversationStore,
  cached: CachedConversation
): number {
  if (store.conversationKey !== cached.conversationId) return 0

  const existingIds = new Set(store.turns.map((turn) => turn.id))
  let hydrated = 0

  for (let i = 0; i < cached.turns.length; i++) {
    const cachedTurn = cached.turns[i]!
    if (existingIds.has(cachedTurn.id)) continue

    const messageId = cachedTurn.userMessageId ?? cachedTurn.id
    let message = store.messages.get(messageId)
    if (!message) {
      message = {
        id: messageId,
        role: 'user',
        // 只恢复导航元数据：preview 截断文本用于目录与搜索，不是完整 prompt
        text: cachedTurn.preview ?? cachedTurn.title,
        turnIndex: cachedTurn.index,
        element: undefined,
        firstSeenAt: cached.updatedAt,
        isMounted: false,
        // 健康分析覆盖度标记：缓存恢复的是截断文本（Runtime-only，不写入缓存 DTO）；
        // Live reconcile 绑定后由 Indexer 升级为 'full'
        contentCompleteness: 'preview'
      }
      store.messages.set(messageId, message)
    }

    const turn: ConversationTurn = {
      id: cachedTurn.id,
      index: cachedTurn.index,
      user: message,
      root: undefined,
      title: cachedTurn.title,
      preview: cachedTurn.preview ?? ''
    }

    // 锚点插入：向前找最近一个已在 store 中的缓存邻居插到其后；
    // 找不到再向后找插到其前；都没有（纯缓存恢复）追加到末尾
    let insertAt = store.turns.length
    for (let j = i - 1; j >= 0; j--) {
      const anchorId = cached.turns[j]!.id
      const anchorIndex = store.turns.findIndex((turn) => turn.id === anchorId)
      if (anchorIndex !== -1) {
        insertAt = anchorIndex + 1
        break
      }
    }
    if (insertAt === store.turns.length) {
      for (let j = i + 1; j < cached.turns.length; j++) {
        const anchorId = cached.turns[j]!.id
        const anchorIndex = store.turns.findIndex((turn) => turn.id === anchorId)
        if (anchorIndex !== -1) {
          insertAt = anchorIndex
          break
        }
      }
    }
    store.turns.splice(insertAt, 0, turn)
    existingIds.add(cachedTurn.id)
    hydrated++
  }

  if (hydrated > 0) {
    store.reindexTurns()
    store.cacheHydrated = true
  }
  return hydrated
}

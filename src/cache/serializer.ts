import type { ConversationStore } from '../conversation/store'
import type { CachedConversation, CachedTurn } from './types.ts'
import { CACHE_SCHEMA_VERSION } from './types.ts'

/**
 * Runtime Store → CachedConversation DTO 的显式序列化（纯函数）。
 *
 * 只读取 store.turns 中已确认的 user turns 的导航元数据（id / 顺序 / 标题 / preview），
 * 不触碰 DOM、不读取消息正文全文 —— title / preview 沿用 Indexer 已生成的字段，
 * 不引入第二套标题算法。结果可安全 JSON 序列化（无 HTMLElement / Map / 循环引用）。
 */

export interface SerializeMetadata {
  provider: string

  conversationId: string

  complete: boolean

  pinned: boolean

  /** 已有缓存的创建时间（保留 createdAt 语义）；缺省用当前时间 */
  createdAt?: number
}

export function serializeConversation(
  store: ConversationStore,
  metadata: SerializeMetadata
): CachedConversation {
  const now = Date.now()
  const userTurns = store.turns.filter((turn) => turn.user)
  const turns: CachedTurn[] = userTurns.map((turn, index) => {
    const cached: CachedTurn = {
      id: turn.id,
      index,
      userMessageId: turn.user?.id,
      title: turn.title
    }
    if (turn.preview) cached.preview = turn.preview
    return cached
  })

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    provider: metadata.provider,
    conversationId: metadata.conversationId,
    createdAt: metadata.createdAt ?? now,
    updatedAt: now,
    lastAccessAt: now,
    turnCount: turns.length,
    complete: metadata.complete,
    pinned: metadata.pinned,
    turns
  }
}

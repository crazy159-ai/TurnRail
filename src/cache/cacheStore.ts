import { reportError } from '../utils/logger.ts'
import { parseCacheIndex, parseCachedConversation } from './validate.ts'
import type {
  CacheIndexEntry,
  CacheIndexMap,
  CacheStats,
  CachedConversation,
  StorageAreaLike
} from './types.ts'
import { CACHE_INDEX_KEY, conversationCacheKey, detectChromeLocalStorage } from './types.ts'

/**
 * 会话导航缓存持久层：唯一允许接触 chrome.storage 的模块。
 * 不感知 ChatGPT DOM / selector，不感知 UI；所有调用完全容错 ——
 * 任何 storage 失败都会把自身标记为不可用并静默降级（Live-only 模式），
 * 绝不让缓存问题影响 TurnRail 正常启动与导航。
 *
 * key 结构：turnrail:conversation:<provider>:<conversationId> + 索引 turnrail:cache:index
 */
export class ConversationCacheStore {
  private storage: StorageAreaLike | null
  private stats: CacheStats = {
    available: true,
    hit: null,
    provider: null,
    conversationId: null,
    cachedTurns: null,
    complete: null,
    pinned: null,
    readMs: null,
    lastWriteMs: null,
    lastWriteAt: null
  }

  constructor(storage?: StorageAreaLike | null) {
    this.storage = storage === undefined ? detectChromeLocalStorage() : storage
    this.stats.available = this.storage !== null
  }

  isAvailable(): boolean {
    return this.storage !== null
  }

  getStats(): CacheStats {
    return { ...this.stats }
  }

  async get(provider: string, conversationId: string): Promise<CachedConversation | null> {
    const storage = this.storage
    if (!storage) return null
    const startedAt = performance.now()
    try {
      const key = conversationCacheKey(provider, conversationId)
      const result = await storage.get(key)
      const parsed = parseCachedConversation(result[key])
      this.stats.hit = parsed !== null
      this.stats.provider = provider
      this.stats.conversationId = conversationId
      this.stats.cachedTurns = parsed?.turnCount ?? 0
      this.stats.complete = parsed?.complete ?? null
      this.stats.pinned = parsed?.pinned ?? null
      return parsed
    } catch (err) {
      this.markUnavailable('read', err)
      return null
    } finally {
      this.stats.readMs = performance.now() - startedAt
    }
  }

  async put(conversation: CachedConversation): Promise<void> {
    const storage = this.storage
    if (!storage) return
    const startedAt = performance.now()
    try {
      const key = conversationCacheKey(conversation.provider, conversation.conversationId)
      await storage.set({ [key]: conversation })
      await this.updateIndex(conversation.provider, conversation.conversationId, (index) => {
        index[key] = {
          provider: conversation.provider,
          conversationId: conversation.conversationId,
          updatedAt: conversation.updatedAt,
          lastAccessAt: conversation.lastAccessAt,
          turnCount: conversation.turnCount,
          complete: conversation.complete,
          pinned: conversation.pinned
        }
        return index
      })
      this.stats.lastWriteMs = performance.now() - startedAt
      this.stats.lastWriteAt = Date.now()
    } catch (err) {
      this.markUnavailable('write', err)
    }
  }

  async remove(provider: string, conversationId: string): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      const key = conversationCacheKey(provider, conversationId)
      await storage.remove(key)
      await this.updateIndex(provider, conversationId, (index) => {
        delete index[key]
        return index
      })
      this.stats.lastWriteAt = Date.now()
    } catch (err) {
      this.markUnavailable('remove', err)
    }
  }

  /** 更新索引中的 lastAccessAt（缓存命中时调用；只写索引，不重写会话数据） */
  async touch(provider: string, conversationId: string): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      const now = Date.now()
      await this.updateIndex(provider, conversationId, (index) => {
        const entry = index[conversationCacheKey(provider, conversationId)]
        if (entry) entry.lastAccessAt = now
        return index
      })
      // 同步会话记录内的 lastAccessAt（惰性：命中即写一次，代价可忽略）
      const key = conversationCacheKey(provider, conversationId)
      const result = await storage.get(key)
      const parsed = parseCachedConversation(result[key])
      if (parsed) {
        parsed.lastAccessAt = now
        await storage.set({ [key]: parsed })
      }
    } catch (err) {
      this.markUnavailable('touch', err)
    }
  }

  async setPinned(provider: string, conversationId: string, pinned: boolean): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      const key = conversationCacheKey(provider, conversationId)
      const result = await storage.get(key)
      const parsed = parseCachedConversation(result[key])
      if (!parsed) return
      parsed.pinned = pinned
      await storage.set({ [key]: parsed })
      await this.updateIndex(provider, conversationId, (index) => {
        const entry = index[key]
        if (entry) entry.pinned = pinned
        return index
      })
      this.stats.lastWriteAt = Date.now()
    } catch (err) {
      this.markUnavailable('setPinned', err)
    }
  }

  async list(): Promise<CacheIndexEntry[]> {
    const storage = this.storage
    if (!storage) return []
    try {
      const result = await storage.get(CACHE_INDEX_KEY)
      const index = parseCacheIndex(result[CACHE_INDEX_KEY])
      return Object.values(index)
    } catch (err) {
      this.markUnavailable('list', err)
      return []
    }
  }

  async clear(): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      const result = await storage.get(CACHE_INDEX_KEY)
      const index = parseCacheIndex(result[CACHE_INDEX_KEY])
      for (const key of Object.keys(index)) await storage.remove(key)
      await storage.remove(CACHE_INDEX_KEY)
      this.stats.lastWriteAt = Date.now()
    } catch (err) {
      this.markUnavailable('clear', err)
    }
  }

  /** 读索引 → 修改 → 写回；索引损坏时按空索引重建（条目会在下次 put 时恢复） */
  private async updateIndex(
    provider: string,
    conversationId: string,
    mutate: (index: CacheIndexMap) => CacheIndexMap
  ): Promise<void> {
    const storage = this.storage
    if (!storage) return
    const result = await storage.get(CACHE_INDEX_KEY)
    const index = parseCacheIndex(result[CACHE_INDEX_KEY])
    // 当前会话条目缺失但会话数据存在时（索引曾被清坏），补一个最小条目
    if (index[conversationCacheKey(provider, conversationId)] === undefined) {
      index[conversationCacheKey(provider, conversationId)] = {
        provider,
        conversationId,
        updatedAt: 0,
        lastAccessAt: 0,
        turnCount: 0,
        complete: false,
        pinned: false
      }
    }
    await storage.set({ [CACHE_INDEX_KEY]: mutate(index) })
  }

  /** storage 不可恢复的失败：标记不可用，此后所有方法静默空操作（Live-only 兜底） */
  private markUnavailable(operation: string, err: unknown): void {
    if (this.storage !== null) {
      this.storage = null
      this.stats.available = false
      reportError(`cache.${operation}`, err)
    }
  }
}

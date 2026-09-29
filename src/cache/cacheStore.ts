import { debugWarn, reportError } from '../utils/logger.ts'
import { isExtensionContextInvalidated } from './errors.ts'
import { parseCacheIndex, parseCachedConversation } from './validate.ts'
import type {
  CacheIndexEntry,
  CacheIndexMap,
  CacheStats,
  CacheUnavailableReason,
  CachedConversation,
  StorageAreaLike
} from './types.ts'
import { CACHE_INDEX_KEY, conversationCacheKey, detectChromeLocalStorage } from './types.ts'

/**
 * 会话导航缓存持久层：唯一允许接触 chrome.storage 的模块。
 * 不感知 ChatGPT DOM / selector，不感知 UI；所有调用完全容错 ——
 * 任何 storage 失败都会把自身标记为不可用并降级（Live-only 模式），
 * 绝不让缓存问题影响 TurnRail 正常启动与导航。
 * v1.2.2：失败会先分类 —— "Extension context invalidated"（扩展重载的预期
 * 生命周期异常）只留 DEBUG 日志；其他未知 storage 故障仍走 reportError。
 *
 * key 结构：turnrail:conversation:<provider>:<conversationId> + 索引 turnrail:cache:index
 */
export class ConversationCacheStore {
  private storage: StorageAreaLike | null
  /** 不可用原因（只存内存）：available 时为 null，missing-api / context-invalidated / storage-error */
  private unavailableReason: CacheUnavailableReason | null
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
    this.unavailableReason = this.storage === null ? 'missing-api' : null
  }

  isAvailable(): boolean {
    return this.storage !== null
  }

  /** 最近一次不可用的原因（内存态；available 时为 null）。供 bootstrap 区分提示文案 */
  getUnavailableReason(): CacheUnavailableReason | null {
    return this.unavailableReason
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

  /** true = 写入完整成功；false = storage 不可用或写入失败（调用方据此决定 UI，绝不假成功） */
  async put(conversation: CachedConversation): Promise<boolean> {
    const storage = this.storage
    if (!storage) return false
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
      return true
    } catch (err) {
      this.markUnavailable('write', err)
      return false
    }
  }

  /** true = 会话数据移除 + 索引更新完整成功 */
  async remove(provider: string, conversationId: string): Promise<boolean> {
    const storage = this.storage
    if (!storage) return false
    try {
      const key = conversationCacheKey(provider, conversationId)
      await storage.remove(key)
      await this.updateIndex(provider, conversationId, (index) => {
        delete index[key]
        return index
      })
      this.stats.lastWriteAt = Date.now()
      return true
    } catch (err) {
      this.markUnavailable('remove', err)
      return false
    }
  }

  /** 更新索引中的 lastAccessAt（缓存命中时调用；只写索引，不重写会话数据） */
  async touch(provider: string, conversationId: string): Promise<boolean> {
    const storage = this.storage
    if (!storage) return false
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
      return true
    } catch (err) {
      this.markUnavailable('touch', err)
      return false
    }
  }

  async setPinned(provider: string, conversationId: string, pinned: boolean): Promise<boolean> {
    const storage = this.storage
    if (!storage) return false
    try {
      const key = conversationCacheKey(provider, conversationId)
      const result = await storage.get(key)
      const parsed = parseCachedConversation(result[key])
      if (!parsed) return true // 目标不存在，无存储错误，视为完成
      parsed.pinned = pinned
      await storage.set({ [key]: parsed })
      await this.updateIndex(provider, conversationId, (index) => {
        const entry = index[key]
        if (entry) entry.pinned = pinned
        return index
      })
      this.stats.lastWriteAt = Date.now()
      return true
    } catch (err) {
      this.markUnavailable('setPinned', err)
      return false
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

  async clear(): Promise<boolean> {
    const storage = this.storage
    if (!storage) return false
    try {
      const result = await storage.get(CACHE_INDEX_KEY)
      const index = parseCacheIndex(result[CACHE_INDEX_KEY])
      for (const key of Object.keys(index)) await storage.remove(key)
      await storage.remove(CACHE_INDEX_KEY)
      this.stats.lastWriteAt = Date.now()
      return true
    } catch (err) {
      this.markUnavailable('clear', err)
      return false
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

  /**
   * storage 不可恢复的失败：标记不可用，此后所有方法静默空操作（Live-only 兜底）。
   * v1.2.2：先分类再上报 —— 只有"Extension context invalidated"（扩展重载的预期
   * 生命周期异常）安静降级为 DEBUG 日志；其余未知 storage 故障仍走 reportError，
   * 绝不吞掉真实错误。
   */
  private markUnavailable(operation: string, err: unknown): void {
    if (this.storage === null) return
    this.storage = null
    this.stats.available = false
    if (isExtensionContextInvalidated(err)) {
      this.unavailableReason = 'extension-context-invalidated'
      debugWarn(`cache.${operation}: extension context invalidated; falling back to Live-only mode`)
      return
    }
    this.unavailableReason = 'storage-error'
    reportError(`cache.${operation}`, err)
  }
}

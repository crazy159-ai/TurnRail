import { debugLog, reportError } from '../utils/logger.ts'
import { classifyCacheFailure } from './errors.ts'
import { parseCacheIndex, parseCachedConversation } from './validate.ts'
import type {
  CacheIndexEntry,
  CacheIndexMap,
  CacheRuntimeState,
  CacheStats,
  CacheUnavailableReason,
  CachedConversation,
  ExtensionContextProbe,
  StorageAreaLike
} from './types.ts'
import {
  CACHE_INDEX_KEY,
  conversationCacheKey,
  detectChromeLocalStorage,
  detectExtensionContext
} from './types.ts'

/** ConversationCacheStore 构造参数（测试注入替身；省略的字段取生产默认值） */
export interface ConversationCacheStoreOptions {
  /** 注入 storage 实现；undefined = 自动探测 chrome.storage.local；null = 强制不可用 */
  storage?: StorageAreaLike | null

  /**
   * extension context 探测（pre-flight）。默认 detectExtensionContext；
   * 测试可注入 () => 'alive' / 'invalid' / 'unknown'，不依赖真实 Chrome。
   */
  contextProbe?: ExtensionContextProbe
}

/** 区分 options 对象与旧的位置参数 storage（StorageAreaLike 永远不会有这两个 key） */
function isStoreOptions(
  value: ConversationCacheStoreOptions | StorageAreaLike | null | undefined
): value is ConversationCacheStoreOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('storage' in value || 'contextProbe' in value)
  )
}

/**
 * 会话导航缓存持久层：唯一允许接触 chrome.storage 的模块。
 * 不感知 ChatGPT DOM / selector，不感知 UI；所有调用完全容错 ——
 * 任何 storage 失败都会把自身标记为不可用并降级（Live-only 模式），
 * 绝不让缓存问题影响 TurnRail 正常启动与导航。
 *
 * v1.2.3 Cache Runtime Lifecycle：可用性建模为显式状态机（CacheRuntimeState），
 * 不再以 storage=null + reason 的字段组合隐式表示：
 *
 * ```text
 *                     page load
 *                        │
 *                        ▼
 *                   AVAILABLE
 *                   /       \
 *                  /         \
 *        missing API         storage error
 *                /             \
 *               ▼               ▼
 *        MISSING_API       STORAGE_ERROR
 *               \               /
 *                \             /
 *                 └─── terminal
 *
 * AVAILABLE
 *    │  context invalidated（pre-flight probe 或 storage 调用失败）
 *    ▼
 * CONTEXT_INVALIDATED
 *    └── terminal until page reload
 * ```
 *
 * unavailable 是 terminal 状态：只允许第一次转换（transitionUnavailable 幂等），
 * 此后所有方法直接短路返回，绝不再触碰 chrome.storage（不重试、不重新探测
 * storage、不轮询恢复）—— 旧 content script 的 context 已无法在本页面生命周期
 * 内复活，只有页面 reload 后由新 content script 重新构造 CacheStore 才能恢复。
 *
 * key 结构：turnrail:conversation:<provider>:<conversationId> + 索引 turnrail:cache:index
 */
export class ConversationCacheStore {
  private state: CacheRuntimeState
  private contextProbe: ExtensionContextProbe
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

  constructor(options?: ConversationCacheStoreOptions | StorageAreaLike | null) {
    const opts = isStoreOptions(options) ? options : { storage: options }
    this.contextProbe = opts.contextProbe ?? detectExtensionContext
    const storage = opts.storage === undefined ? detectChromeLocalStorage() : opts.storage
    this.state = storage
      ? { status: 'available', storage }
      : { status: 'unavailable', reason: 'missing-api' }
    this.stats.available = storage !== null
  }

  /** 简单状态读取：不触碰 chrome.runtime / storage（context probe 只在真正执行 cache 操作前进行） */
  isAvailable(): boolean {
    return this.state.status === 'available'
  }

  /** 最近一次不可用的原因（内存态；available 时为 null）。供 bootstrap 区分提示文案 */
  getUnavailableReason(): CacheUnavailableReason | null {
    return this.state.status === 'unavailable' ? this.state.reason : null
  }

  getStats(): CacheStats {
    return { ...this.stats }
  }

  async get(provider: string, conversationId: string): Promise<CachedConversation | null> {
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
    const storage = this.getStorage()
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
   * 所有 storage 操作的唯一入口（pre-flight gate）。
   * unavailable → null（terminal 短路）；available 时先做 context probe ——
   * probe === 'invalid' 直接 terminal 转换，避免必然失败的 storage 调用；
   * 'alive' / 'unknown'（测试与 mock 环境）放行注入的实现。
   */
  private getStorage(): StorageAreaLike | null {
    if (this.state.status !== 'available') return null
    if (this.contextProbe() === 'invalid') {
      this.transitionUnavailable('extension-context-invalidated', 'context-probe')
      return null
    }
    return this.state.storage
  }

  /**
   * 统一 terminal 转换：只允许第一次，此后重复调用一律 no-op（天然保证
   * lifecycle 日志与 reportError 只出现一次）。storage 调用失败的 catch 路径
   * 与 pre-flight probe 都汇入这里，绝不各自改状态。
   */
  private transitionUnavailable(
    reason: CacheUnavailableReason,
    source: string,
    err?: unknown
  ): void {
    if (this.state.status === 'unavailable') return
    this.state = { status: 'unavailable', reason }
    this.stats.available = false
    if (reason === 'extension-context-invalidated') {
      // 预期生命周期事件（v1.2.3）：DEBUG 下仅一条 debug 级 lifecycle 日志，
      // 生产完全静默 —— 绝不 warn / error / reportError。transitionUnavailable
      // 幂等保证同一页面生命周期最多这一条。
      debugLog(
        `cache lifecycle: extension context invalidated (via ${source}); cache disabled until page reload`
      )
      return
    }
    if (reason === 'storage-error') {
      // 未知 storage 故障：绝不能被"消 warning"吞掉真实错误
      reportError(`cache.${source}`, err)
    }
    // missing-api：构造期已知的环境事实，无需日志
  }

  /** storage 调用失败的 catch 路径：先分类（expected lifecycle vs 真实故障）再统一转换 */
  private markUnavailable(operation: string, err: unknown): void {
    this.transitionUnavailable(classifyCacheFailure(err), operation, err)
  }
}

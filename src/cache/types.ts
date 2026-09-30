/**
 * 导航缓存（Navigation Cache）数据模型。
 *
 * 缓存的是"会话导航元数据"（turn id / 顺序 / 标题 / 短 preview），
 * 绝不缓存 assistant 正文、HTML、图片、附件或任何 DOM 引用。
 * 缓存模型（本文件）与 Runtime 模型（conversation/types.ts）刻意隔离，
 * 两者之间只允许经过 serializer / hydrator 显式转换。
 */

export const CACHE_SCHEMA_VERSION = 1

/** chrome.storage.local 中单条会话缓存的 key（带 provider 前缀，为多 Provider 预留） */
export function conversationCacheKey(provider: string, conversationId: string): string {
  return `turnrail:conversation:${provider}:${conversationId}`
}

/** 缓存索引（元信息汇总）的 storage key，避免读取时反序列化全部会话 */
export const CACHE_INDEX_KEY = 'turnrail:cache:index'

/** 单个 turn 的缓存形态：只含导航所需字段 */
export interface CachedTurn {
  /** Runtime turn 稳定 id（user 消息稳定 ID，与 data-turn-key 同族） */
  id: string

  /** user turn 序号（从 0 起，用于恢复 Q 编号） */
  index: number

  /** user 消息稳定 ID（恢复后与 Live 消息 key 对齐）；缺省时回退 id */
  userMessageId?: string

  /** 问题标题（沿用现有 title 生成逻辑，≤60 字符） */
  title: string

  /** 短 preview（沿用现有 preview 生成逻辑，≤160 字符） */
  preview?: string
}

/** 单个会话的缓存形态（DTO，与 Runtime Store 无共享可变结构） */
export interface CachedConversation {
  schemaVersion: 1

  /** 来源 Provider，当前固定 'chatgpt' */
  provider: string

  conversationId: string

  createdAt: number

  updatedAt: number

  lastAccessAt: number

  /** user turn 数量 */
  turnCount: number

  /**
   * 仅当 TurnRail 明确完成一次完整历史捕获（如「加载全部历史」确认到顶）才为 true；
   * 自然打开会话即使已索引多个 turn 也为 false（缓存可能只含已加载部分）。
   */
  complete: boolean

  /** v1.1 语义：true = 用户主动缓存（☆→★）的会话 */
  pinned: boolean

  turns: CachedTurn[]
}

/** 缓存索引条目：读取会话前可先看元信息，不必反序列化 turns */
export interface CacheIndexEntry {
  provider: string

  conversationId: string

  updatedAt: number

  lastAccessAt: number

  turnCount: number

  complete: boolean

  pinned: boolean
}

/** 索引在 storage 中的存储形态：conversationKey → entry */
export type CacheIndexMap = Record<string, CacheIndexEntry>

/**
 * v1.2.2：storage 不可用的原因（只存在于内存，绝不写入 chrome.storage）。
 * missing-api = 环境没有 chrome.storage.local；
 * extension-context-invalidated = 扩展重载后旧 context 的预期生命周期异常；
 * storage-error = 其他未知 storage 故障（仍走 reportError）。
 */
export type CacheUnavailableReason =
  | 'missing-api'
  | 'extension-context-invalidated'
  | 'storage-error'

/**
 * v1.2.3：extension context 探测结果（轻量 probe，只读 chrome.runtime.id，零 API 调用）。
 * alive   = chrome.runtime.id 存在 —— context 明确有效；
 * invalid = chrome.runtime 存在但 id 缺失 / 属性访问即抛 —— context 明确失效；
 * unknown = 非 extension 环境（Node 单元测试 / mock 测试台无 chrome.runtime）无法判断
 *           —— 不下结论，允许注入的 fake storage 继续工作（绝不把测试环境误判为失效）。
 */
export type ExtensionContextState = 'alive' | 'invalid' | 'unknown'

/** context 探测函数（CacheStore 可注入替身，见 ConversationCacheStoreOptions） */
export type ExtensionContextProbe = () => ExtensionContextState

/**
 * v1.2.3：cache 运行时状态 —— 显式状态机，替代 storage=null + reason 的隐式组合。
 *
 *   AVAILABLE ── missing API ──→ MISSING_API（terminal）
 *   AVAILABLE ── storage error ─→ STORAGE_ERROR（terminal）
 *   AVAILABLE ── context invalidated（probe 或调用失败）──→ CONTEXT_INVALIDATED（terminal）
 *
 * unavailable 是 terminal 状态：只允许一次转换，此后所有方法短路，绝不再触碰
 * chrome.storage；恢复的唯一途径是页面 reload 后由新 content script 重新构造。
 */
export type CacheRuntimeState =
  | { status: 'available'; storage: StorageAreaLike }
  | { status: 'unavailable'; reason: CacheUnavailableReason }

/** DEBUG 指标（只含元数据，绝不含任何聊天正文） */
export interface CacheStats {
  available: boolean
  hit: boolean | null
  provider: string | null
  conversationId: string | null
  cachedTurns: number | null
  complete: boolean | null
  pinned: boolean | null
  readMs: number | null
  lastWriteMs: number | null
  lastWriteAt: number | null
}

/**
 * chrome.storage.local 的最小结构子集。
 * 显式声明而非依赖 @types/chrome；生产环境由 chrome.storage.local 提供，
 * 测试环境注入内存实现。cache 层运行时 import 一律带 .ts 扩展名
 * （Node test runner 需要可解析的显式路径）。
 */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

declare const chrome:
  | { storage?: { local?: StorageAreaLike }; runtime?: { id?: unknown } }
  | undefined

/** 探测当前环境可用的 storage（chrome.storage.local），不可用返回 null */
export function detectChromeLocalStorage(): StorageAreaLike | null {
  try {
    const local = typeof chrome !== 'undefined' ? chrome?.storage?.local : undefined
    if (local && typeof local.get === 'function' && typeof local.set === 'function') {
      return local
    }
  } catch {
    // chrome API 探测失败 → 视为不可用
  }
  return null
}

/**
 * v1.2.3：生产 context 探测（零 API 调用，只读 chrome.runtime.id）。
 * 扩展重载后旧 content script 的 chrome.runtime.id 变为缺失（部分版本连属性访问
 * 都会抛出）→ invalid；mock / Node 测试环境没有 chrome.runtime → unknown（放行）。
 * 注意：probe 只是 pre-flight 优化，正确性由 CacheStore 的 try/catch fallback 兜底。
 */
export function detectExtensionContext(): ExtensionContextState {
  try {
    const runtime = typeof chrome !== 'undefined' ? chrome?.runtime : undefined
    if (!runtime || typeof runtime !== 'object') return 'unknown'
    return typeof runtime.id === 'string' && runtime.id.length > 0 ? 'alive' : 'invalid'
  } catch {
    // context 失效时连属性访问都可能抛出 → 明确失效
    return 'invalid'
  }
}

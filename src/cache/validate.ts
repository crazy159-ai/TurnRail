import type { CacheIndexEntry, CacheIndexMap, CachedConversation, CachedTurn } from './types.ts'
import { CACHE_SCHEMA_VERSION } from './types.ts'

/**
 * 缓存数据验证：所有从 storage 读出的 raw 数据必须先经过这里。
 * 任何结构异常（字段缺失 / 类型错误 / 未来 schema）一律返回 null，
 * 由调用方"丢弃该缓存 → 继续使用 Live DOM"，绝不抛错。
 *
 * 未来 schema migration 的唯一入口也在这里：当前版本对
 * schemaVersion > CACHE_SCHEMA_VERSION 一律忽略（ignore → live rebuild），
 * 之后需要迁移时只需扩展本函数，不影响调用方。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseCachedTurn(raw: unknown): CachedTurn | null {
  if (!isRecord(raw)) return null
  const id = asNonEmptyString(raw.id)
  const index = asFiniteNumber(raw.index)
  const title = typeof raw.title === 'string' ? raw.title : null
  if (id === null || index === null || index < 0 || title === null) return null
  const turn: CachedTurn = {
    id,
    index: Math.floor(index),
    title: title.slice(0, 300)
  }
  const userMessageId = asOptionalString(raw.userMessageId)
  if (userMessageId) turn.userMessageId = userMessageId
  const preview = asOptionalString(raw.preview)
  if (preview) turn.preview = preview.slice(0, 400)
  return turn
}

/**
 * 解析单条会话缓存。
 * schemaVersion 不等于当前版本（含未来版本）→ null（忽略，走 live rebuild）。
 */
export function parseCachedConversation(raw: unknown): CachedConversation | null {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== CACHE_SCHEMA_VERSION) return null

  const provider = asNonEmptyString(raw.provider)
  const conversationId = asNonEmptyString(raw.conversationId)
  const createdAt = asFiniteNumber(raw.createdAt)
  const updatedAt = asFiniteNumber(raw.updatedAt)
  const lastAccessAt = asFiniteNumber(raw.lastAccessAt)
  const turnCount = asFiniteNumber(raw.turnCount)
  if (
    provider === null ||
    conversationId === null ||
    createdAt === null ||
    updatedAt === null ||
    lastAccessAt === null ||
    turnCount === null ||
    typeof raw.complete !== 'boolean' ||
    typeof raw.pinned !== 'boolean' ||
    !Array.isArray(raw.turns)
  ) {
    return null
  }

  const turns: CachedTurn[] = []
  for (const item of raw.turns) {
    const turn = parseCachedTurn(item)
    if (turn === null) return null
    turns.push(turn)
  }
  // turnCount 与 turns 长度不一致视为损坏（写入方始终保证两者一致）
  if (turns.length !== turnCount) return null

  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    provider,
    conversationId,
    createdAt,
    updatedAt,
    lastAccessAt,
    turnCount,
    complete: raw.complete,
    pinned: raw.pinned,
    turns
  }
}

function parseCacheIndexEntry(raw: unknown): CacheIndexEntry | null {
  if (!isRecord(raw)) return null
  const provider = asNonEmptyString(raw.provider)
  const conversationId = asNonEmptyString(raw.conversationId)
  const updatedAt = asFiniteNumber(raw.updatedAt)
  const lastAccessAt = asFiniteNumber(raw.lastAccessAt)
  const turnCount = asFiniteNumber(raw.turnCount)
  if (
    provider === null ||
    conversationId === null ||
    updatedAt === null ||
    lastAccessAt === null ||
    turnCount === null ||
    typeof raw.complete !== 'boolean' ||
    typeof raw.pinned !== 'boolean'
  ) {
    return null
  }
  return { provider, conversationId, updatedAt, lastAccessAt, turnCount, complete: raw.complete, pinned: raw.pinned }
}

/** 解析缓存索引 map；损坏的条目直接丢弃，不影响其余条目 */
export function parseCacheIndex(raw: unknown): CacheIndexMap {
  const result: CacheIndexMap = {}
  if (!isRecord(raw)) return result
  for (const [key, value] of Object.entries(raw)) {
    const entry = parseCacheIndexEntry(value)
    if (entry !== null) result[key] = entry
  }
  return result
}

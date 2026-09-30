import { fnv1a } from '../conversation/stableId'
import { detectChromeLocalStorage } from '../cache/types'
import type { StorageAreaLike } from '../cache/types'
import { PENDING_HANDOFF_KEY, PENDING_HANDOFF_TTL_MS } from './types'
import type { PendingHandoff } from './types'

/**
 * PendingHandoff 存储（Handoff V1 跨标签页通道）：
 * - 独立命名空间 turnrail:handoff:pending，绝不复用 turnrail:cache:index；
 * - 产品 TTL（10 分钟）：到期 peek 即删即作废；注入成功 consume 即删；
 *   取消路径根本不产生 pending；
 * - 与 CacheStore 的 terminal 状态机刻意不同：这是极小的一次性读写，
 *   任何失败（含 extension context invalidated）都返回 false / null，
 *   由调用方回退"复制到剪贴板"路径，绝不假成功、绝不重试轮询。
 * - 隐私契约：短生命周期、可能包含用户选定的完整正文（README/SECURITY 已声明），
 *   绝不导出 payload 到诊断 / 控制台。
 */
export class PendingHandoffStore {
  private storage: StorageAreaLike | null

  constructor(storage?: StorageAreaLike | null) {
    this.storage = storage === undefined ? detectChromeLocalStorage() : storage
  }

  isAvailable(): boolean {
    return this.storage !== null
  }

  /** 保存 pending（覆盖旧 pending：同一时刻至多一个）。true = 写入真实成功 */
  async save(payload: string): Promise<boolean> {
    const storage = this.storage
    if (!storage || payload.length === 0) return false
    try {
      const now = Date.now()
      const pending: PendingHandoff = {
        schemaVersion: 1,
        id: `handoff-${now.toString(36)}-${fnv1a(payload.slice(0, 512))}`,
        createdAt: now,
        expiresAt: now + PENDING_HANDOFF_TTL_MS,
        sourceProvider: 'chatgpt',
        payload
      }
      await storage.set({ [PENDING_HANDOFF_KEY]: pending })
      return true
    } catch {
      // 含 "Extension context invalidated."：交给调用方走剪贴板回退
      return false
    }
  }

  /** 读取有效 pending；过期记录立即删除并返回 null。任何失败返回 null */
  async peek(): Promise<PendingHandoff | null> {
    const storage = this.storage
    if (!storage) return null
    try {
      const result = await storage.get(PENDING_HANDOFF_KEY)
      const pending = parsePendingHandoff(result[PENDING_HANDOFF_KEY])
      if (!pending) return null
      if (Date.now() > pending.expiresAt) {
        await this.remove()
        return null
      }
      return pending
    } catch {
      return null
    }
  }

  /** 消费：peek + 立即删除（注入成功后调用） */
  async consume(): Promise<PendingHandoff | null> {
    const pending = await this.peek()
    if (pending) await this.remove()
    return pending
  }

  async remove(): Promise<void> {
    const storage = this.storage
    if (!storage) return
    try {
      await storage.remove(PENDING_HANDOFF_KEY)
    } catch {
      // 删除失败同样静默：TTL 到期后记录自然作废
    }
  }
}

/** 入读校验：schema / 字段类型全部确认后才信任记录（损坏数据 = 无 pending） */
function parsePendingHandoff(value: unknown): PendingHandoff | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 1) return null
  if (typeof v.id !== 'string' || v.id.length === 0) return null
  if (typeof v.createdAt !== 'number' || typeof v.expiresAt !== 'number') return null
  if (typeof v.sourceProvider !== 'string' || v.sourceProvider.length === 0) return null
  if (typeof v.payload !== 'string' || v.payload.length === 0) return null
  return {
    schemaVersion: 1,
    id: v.id,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    sourceProvider: v.sourceProvider,
    payload: v.payload
  }
}

import { fnv1a } from '../conversation/stableId'
import type { CheckpointStatus, CheckpointTurnRef, ConversationCheckpoint } from './types'

/**
 * Checkpoint 内存仓库（Handoff V1）：
 * - 按会话 id 分桶，天然实现 SPA 路由隔离（A / B 互不可见，A→B→A 恢复）；
 * - 只存定位元数据，附着于稳定 turnId —— 虚拟化卸载 / Store reset 都不影响；
 * - star / unstar 完全可逆；同一 turn 的 id 恒定（chk- + fnv1a），天然去重；
 * - 生命周期与页面一致：不写 chrome.storage（刷新后需重新标记，属 V1 已知限制，
 *   README 已说明），也绝无网络行为。
 */
export class CheckpointStore {
  private byConversation = new Map<string, Map<string, ConversationCheckpoint>>()

  /** 标记 / 取消标记（可逆）。返回 true = 标记后状态为"已标记" */
  toggle(conversationId: string, turn: CheckpointTurnRef): boolean {
    const bucket = this.byConversation.get(conversationId)
    if (bucket && bucket.has(turn.id)) {
      bucket.delete(turn.id)
      if (bucket.size === 0) this.byConversation.delete(conversationId)
      return false
    }
    const checkpoint: ConversationCheckpoint = {
      id: checkpointId(conversationId, turn.id),
      conversationId,
      turnId: turn.id,
      turnIndex: turn.index,
      createdAt: Date.now(),
      kind: 'custom',
      status: 'active'
    }
    if (!bucket) {
      this.byConversation.set(conversationId, new Map([[turn.id, checkpoint]]))
    } else {
      bucket.set(turn.id, checkpoint)
    }
    return true
  }

  isCheckpointed(conversationId: string, turnId: string): boolean {
    return this.byConversation.get(conversationId)?.has(turnId) ?? false
  }

  /** 当前会话全部 checkpoint（按 turnIndex 升序；构建 Handoff 的输入顺序） */
  list(conversationId: string): ConversationCheckpoint[] {
    const bucket = this.byConversation.get(conversationId)
    if (!bucket) return []
    return Array.from(bucket.values()).sort((a, b) => a.turnIndex - b.turnIndex)
  }

  count(conversationId: string): number {
    return this.byConversation.get(conversationId)?.size ?? 0
  }

  /** 标记 superseded（数据层能力；V1 无 UI，builder 强制排除 superseded） */
  setStatus(conversationId: string, turnId: string, status: CheckpointStatus): boolean {
    const checkpoint = this.byConversation.get(conversationId)?.get(turnId)
    if (!checkpoint) return false
    checkpoint.status = status
    return true
  }
}

/** 稳定 checkpoint id：同一 (conversationId, turnId) 恒定 —— 重复标记天然去重 */
export function checkpointId(conversationId: string, turnId: string): string {
  return `chk-${fnv1a(`${conversationId}\u0000${turnId}`)}`
}

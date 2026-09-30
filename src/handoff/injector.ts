import type { ConversationContinuationCapability } from '../providers/types'
import type { PendingHandoffStore } from './pendingStore'

/**
 * 新聊天页 Handoff 注入（规格 #16/#19）：
 * peek（含 TTL 校验）→ 等待 composer 出现 → setComposerText 只填草稿
 * → 注入成功才 consume 删除。TurnRail 绝不点击发送 —— 最终发送永远由
 * 用户本人确认。
 *
 * 失败语义（全部保守，绝不假成功）：
 * - 无 pending（不存在 / 过期 / storage 失败）→ 'no-pending'，页面零行为
 *   （capability 一次都不会被触碰，规格 Test 20）；
 * - composer 超时未出现 → 'no-composer'，pending 保留由 TTL 兜底过期；
 * - 写入失败 → 'failed'，pending 保留。
 */
export type HandoffInjectionResult = 'no-pending' | 'no-composer' | 'injected' | 'failed'

export interface HandoffInjectionOptions {
  /** 等待 composer 出现的总时长（新页面 React/ProseMirror 挂载窗口） */
  composerWaitMs?: number
  /** composer 轮询间隔 */
  pollIntervalMs?: number
}

export async function injectPendingHandoff(
  capability: ConversationContinuationCapability | null,
  store: PendingHandoffStore,
  options?: HandoffInjectionOptions
): Promise<HandoffInjectionResult> {
  const composerWaitMs = options?.composerWaitMs ?? 8_000
  const pollIntervalMs = options?.pollIntervalMs ?? 300

  const pending = await store.peek()
  if (!pending) return 'no-pending'
  if (!capability) return 'no-composer'

  const deadline = Date.now() + composerWaitMs
  while (capability.getComposer() === null) {
    if (Date.now() >= deadline) return 'no-composer'
    await sleep(pollIntervalMs)
  }

  if (!capability.setComposerText(pending.payload)) return 'failed'
  // 身份安全消费：只删除"刚刚实际注入的那个"pending。若等待 composer 期间
  // 另一标签页已写入新 handoff B，consume(A.id) 返回 false —— B 必须保留，
  // 且本轮不算失败（A 的正文已真实写入 composer）。
  await store.consume(pending.id)
  return 'injected'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

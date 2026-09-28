import type { ProviderRole } from '../providers/types'

export type MessageRole = ProviderRole

export interface ConversationMessage {
  id: string
  role: MessageRole
  text: string
  turnIndex: number
  /** 消息当前挂载时的元素；被虚拟化卸载后为 undefined（metadata 仍保留） */
  element?: HTMLElement
  firstSeenAt: number
  isMounted: boolean
}

export interface ConversationTurn {
  /** 与 user 消息 id 一致（无 user 消息时与 assistant 消息 id 一致） */
  id: string
  index: number
  user?: ConversationMessage
  assistant?: ConversationMessage
  /** turn 容器元素（真实 DOM 为 [data-turn-key]），用于兜底跳转定位 */
  root?: HTMLElement
  title: string
  preview: string
}

/**
 * 已卸载但保留 metadata 的 turn。
 * beforeId / afterId 指定它在重建索引时相对当前可见 turn 的插入位置。
 */
export interface DetachedTurn {
  turn: ConversationTurn
  beforeId?: string
  afterId?: string
  capturedAt: number
}

export type ChangeKind = 'structure' | 'text' | 'elements' | 'none'

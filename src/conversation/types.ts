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
  /**
   * 文本完整度（Runtime-only metadata，绝不写入缓存 DTO）：
   * 'preview' = 缓存 hydrate 恢复的截断文本（preview/title），非完整 prompt；
   * 'full' / undefined = Live DOM 解析的完整原文。健康分析据此计算覆盖度。
   */
  contentCompleteness?: 'full' | 'preview'
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

/**
 * Store 变化事件。'user-text' / 'assistant-text' 区分文本变化的角色：
 * assistant 流式输出（高频、仅 assistant 文本）绝不触发健康重算等语义级工作，
 * 而 user prompt 变化（编辑 / 重解析）必须触发 —— 消费方依赖这一区分。
 * 同批两者都变时 indexer 以 'user-text' 优先上报。
 *
 * 'coverage' 表示 TurnRail 对某条消息的掌握程度变化（preview → full 升级），
 * 用户语义并未改变 —— 即使文本与 preview 完全一致也必须上报，健康覆盖度 /
 * 目录"仅预览"标记等消费者依赖它重算，绝不能因文本相同而被当成无变化。
 */
export type ChangeKind =
  | 'structure'
  | 'user-text'
  | 'assistant-text'
  | 'elements'
  | 'coverage'
  | 'none'

export type ProviderRole = 'user' | 'assistant' | 'unknown'

/** 从页面 DOM 定位出的一条原始消息记录 */
export interface LocatedMessage {
  role: ProviderRole
  text: string
  element: HTMLElement
  /** 所属 turn 容器，可能为 null */
  turnContainer: HTMLElement | null
  /** 稳定消息 ID（DOM 原生 UUID 或 turn 级推导），可能为空 */
  externalId: string | null
}

/**
 * Turn-first 定位结果：真实 ChatGPT DOM 中每个 [data-turn-key] 天然是一个 turn，
 * 内部再分别寻找 user / assistant 单元。
 */
export interface LocatedTurn {
  /** data-turn-key（DOM 原生稳定 UUID）；缺失时为 fallback key */
  id: string
  root: HTMLElement
  user?: LocatedMessage
  assistant?: LocatedMessage
}

/**
 * 站点适配层：所有"针对 ChatGPT DOM 的查询"必须集中在这里，
 * 其余模块只依赖本接口。站点改版时只改这个实现。
 */
export interface ChatProvider {
  readonly name: string

  /** 主路径：按 conversation root → [data-turn-key] 解析 turn */
  locateTurns(): LocatedTurn[]

  /** Legacy fallback：旧 DOM 的消息流式定位 */
  locateMessages(): LocatedMessage[]

  /** 真实会话容器（[data-thread-find-target="conversation"]） */
  getConversationRoot(): HTMLElement | null

  /** UI 可见性依据：存在会话容器即视为会话页（不依赖 URL） */
  hasConversation(): boolean

  getTurnContainer(element: HTMLElement): HTMLElement | null

  /** 会话 ID（/c/<id>），新聊天等无 ID 场景返回 null；仅用作 conversationKey */
  getConversationId(): string | null

  isConversationRoute(): boolean

  /** 会话滚动容器；找不到返回 null */
  getScrollContainer(): HTMLElement | null

  /** 路由切换等场景下清除内部 DOM 缓存 */
  invalidateDomCache(): void

  /** DEBUG：最近一次定位使用的策略标签 */
  lastStrategyLabel: string

  /** DEBUG：最近一次定位到的消息数 */
  lastLocatedCount: number
}

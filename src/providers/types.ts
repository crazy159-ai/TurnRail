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
 * 廉价定位结果：只含 turn root 与原生 id（不做正文提取）。
 * id 为 null 表示该 DOM 缺少 data-turn-key（legacy DOM），增量扫描应回退 full scan。
 */
export interface LocatedTurnRoot {
  id: string | null
  root: HTMLElement
}

/**
 * Mutation 管道所需的站点 selector 提示：
 * 管道自身不认识任何站点属性，selector 由 Provider 集中下发。
 */
export interface ProviderMutationHints {
  /** turn 容器选择器 */
  turnSelector: string
  /** assistant unit 选择器（含 fallback） */
  assistantUnitSelectors: readonly string[]
}

/**
 * Provider 健康诊断（纯元数据，绝不含聊天正文 / 会话 ID / URL）。
 * 供 DEBUG 面板与 diagnostics 导出使用。
 */
export interface ProviderDiagnostics {
  conversationRoot: boolean
  scrollContainer: boolean
  turnRoots: number
  userUnits: number
  assistantUnits: number
  /** 最近一次定位使用的策略标签 */
  strategy: string
}

/**
 * 新聊天标签页预留（popup blocked 防护，Handoff V1）：
 * reserveNewConversation 在用户点击的同步链路内先开 about:blank 占住弹窗资格，
 * pending 保存成功后再导航到目标地址。实现层不暴露裸 Window / location，
 * handoff 模块对 window.open / WindowProxy / opener 保持零知识。
 */
export interface NewConversationReservation {
  /** 导航到 Provider 的新聊天地址。true = 导航指令已发出 */
  navigate(): boolean

  /** 关闭预留标签页（pending 保存失败时回滚，不留空白 tab） */
  close(): void
}

/**
 * 会话延续能力（Conversation Handoff 注入，可选 capability）：
 * 只有具备"新聊天输入框"概念的 Provider 才实现；handoff / UI 模块只依赖
 * 本接口，绝不允许出现任何站点 selector。未来新增 Provider 时按需实现。
 */
export interface ConversationContinuationCapability {
  /** 新聊天 composer 元素；不存在 / 站点改版返回 null */
  getComposer(): HTMLElement | null

  /**
   * 将 draft 文本写入 composer 并触发框架感知的 input 事件。
   * 只填草稿 —— 绝不提交 / 点击发送（TurnRail 的硬性产品约束）。
   * true = 写入真实完成（含最小回读验证）。
   */
  setComposerText(text: string): boolean

  /**
   * 同步预留新聊天标签页（必须在用户点击的同步链路中调用，避免弹窗拦截）。
   * null = 浏览器阻止了新标签页（或 Provider 无法打开）；正文绝不写入 URL。
   */
  reserveNewConversation(): NewConversationReservation | null
}

/**
 * 站点适配层：所有"针对 ChatGPT DOM 的查询"必须集中在这里，
 * 其余模块只依赖本接口。站点改版时只改这个实现。
 */
export interface ChatProvider {
  readonly name: string

  /** 主路径：按 conversation root → [data-turn-key] 解析 turn */
  locateTurns(): LocatedTurn[]

  /** 廉价定位：turn root 列表（已按视觉顺序规整），不做正文提取（增量扫描用） */
  locateTurnRoots(): LocatedTurnRoot[]

  /**
   * 单 turn 解析：full 与 incremental 共用的唯一 parser。
   * includeText=false 时仅绑定元素 / 读取 ID（跳过 cloneNode+innerText），
   * 供增量路径对已知 turn 的重挂载做轻量重绑。
   */
  parseTurn(
    turnRoot: HTMLElement,
    options?: { includeText?: boolean; positionHint?: number }
  ): LocatedTurn | null

  /** Legacy fallback：旧 DOM 的消息流式定位 */
  locateMessages(): LocatedMessage[]

  /** 真实会话容器（[data-thread-find-target="conversation"]） */
  getConversationRoot(): HTMLElement | null

  /** UI 可见性依据：存在会话容器即视为会话页（不依赖 URL） */
  hasConversation(): boolean

  /**
   * UI 可见性兜底：页面存在可识别的会话内容（任何一代 DOM 结构）。
   * UI 不得自行查询站点 selector，一律经由此方法。
   */
  hasRecognizableContent(): boolean

  /** Mutation 管道 selector 提示（管道不 import 任何站点 SELECTORS） */
  getMutationHints(): ProviderMutationHints

  /** 健康诊断（DEBUG / diagnostics 导出用，纯元数据） */
  getDiagnostics(): ProviderDiagnostics

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

/**
 * Conversation Handoff / Checkpoint 数据模型（Handoff V1）。
 *
 * 设计原则（README「Conversation Handoff」章节同步约束）：
 * - Checkpoint 只记录定位元数据（turnId / turnIndex / kind / status），
 *   绝不复制聊天正文长期存储；正文在生成 Handoff 时从 Store 现场读取。
 * - 用户显式标记是唯一的重要性证据 —— TurnRail 不自动推断"最终结论"。
 * - PendingHandoff 为跨标签页注入而短暂保存完整 handoff 文本：
 *   用户主动生成、TTL 限期、消费即删，与长期导航缓存（cache/）严格分离命名空间。
 * - 全部状态只在本地；无网络请求、无遥测（privacyContract.test.ts 强制）。
 */

/** checkpoint 语义分类（V1 仅记录，UI 暂不提供分类菜单，统一 'custom'） */
export type CheckpointKind =
  | 'key-result'
  | 'decision'
  | 'constraint'
  | 'code'
  | 'experiment'
  | 'custom'

/**
 * checkpoint 生效状态（"旧方案污染"防护的最小形态）：
 * superseded 的 checkpoint 永远不会进入 Handoff（builder 强制排除）。
 * V1 仅在数据层支持（无 UI 切换），后续版本提供 Active / Superseded 管理界面。
 */
export type CheckpointStatus = 'active' | 'superseded'

/**
 * 用户标记的 checkpoint：只含定位元数据，不含任何正文。
 * 附着于稳定 turnId / turnIndex，虚拟化卸载（element 移除）不影响其存在。
 */
export interface ConversationCheckpoint {
  /** 稳定 id：chk- + fnv1a(conversationId:turnId)，同一 turn 恒定（天然去重） */
  id: string

  conversationId: string

  /** Store 中 turn 的稳定 id（与 user 消息 id 同族；不是 DOM UUID 之外的新命名体系） */
  turnId: string

  /** Store turnIndex（0 基）；Handoff 渲染时 +1 转为人类可读编号 */
  turnIndex: number

  createdAt: number

  kind: CheckpointKind

  status: CheckpointStatus
}

/** checkpoint 的定位输入（Store turn 的最小投影，避免 Store 与 handoff 模块耦合） */
export interface CheckpointTurnRef {
  id: string
  index: number
}

/** Handoff 全局限额：仅约束 TurnRail 生成的交接包体积，绝不代表 ChatGPT context limit */
export const HANDOFF_LIMITS = {
  /** 最终 markdown 文本字符上限 */
  maxCharacters: 40_000,
  /** 单条 checkpoint 数上限（超出按 turn 序保留前 N 条 + warning） */
  maxCheckpoints: 12,
  /** Recent Tail 的 user turn 数上限（不含当前目标轮） */
  maxRecentTurns: 6,
  /** 单条消息（user / assistant）字符上限，超出按 fence 安全方式截断 */
  maxSingleMessageCharacters: 12_000
} as const

/** PendingHandoff 的产品 TTL（跨 tab 注入窗口），与模型上下文无关 */
export const PENDING_HANDOFF_TTL_MS = 10 * 60 * 1000

/** chrome.storage.local 中 pending handoff 的独立命名空间（绝不写入 turnrail:cache:index） */
export const PENDING_HANDOFF_KEY = 'turnrail:handoff:pending'

/** 短生命周期跨 tab 载荷：TTL 到期自动作废、注入成功即删除、取消即删除 */
export interface PendingHandoff {
  schemaVersion: 1

  id: string

  createdAt: number

  expiresAt: number

  sourceProvider: string

  /** 完整 handoff markdown 文本（预览编辑后的最终版） */
  payload: string
}

/** Handoff 内容块（已经过预算控制；不含任何 id / UUID / URL） */
export interface HandoffSection {
  kind: 'checkpoint' | 'recent' | 'objective'

  /** 人类可读 turn 编号（turnIndex + 1，与目录 Q 编号一致） */
  turnNumber: number

  userText: string

  assistantText: string | null

  /**
   * assistant 正文完整度：'preview' = 仅有缓存截断文本。
   * preview 内容会以显式标记渲染，绝不伪装成完整结论（规格 8.3.1）。
   */
  assistantCompleteness?: 'full' | 'preview'
}

/** Health 快照中允许进入 Handoff 的元数据投影（不回显 prompt / reasons 正文） */
export interface HandoffHealthSummary {
  score: number
  level: string
  confidence: string
}

export interface ConversationHandoff {
  schemaVersion: 1

  generatedAt: number

  source: {
    /** 是否拿到了 conversationId（只报存在性，不输出 id 本身） */
    conversationIdAvailable: boolean

    totalUserTurns: number

    selectedTurns: number

    checkpointCount: number
  }

  health?: HandoffHealthSummary

  sections: HandoffSection[]

  /** 全部截断 / 省略 / 覆盖度告警（元数据级，绝不含正文） */
  warnings: string[]
}

export interface HandoffBuildInput {
  conversationId: string | null

  /** Store turns 的现场快照（调用方在用户点击时同步复制，builder 不访问 Store / DOM） */
  turns: readonly HandoffTurnSnapshot[]

  checkpoints: readonly ConversationCheckpoint[]

  health?: HandoffHealthSummary

  /** 预算覆盖（测试用）；缺省用 HANDOFF_LIMITS */
  limits?: Partial<typeof HANDOFF_LIMITS>
}

/**
 * builder 输入的单个 turn 快照。
 * completeness 语义与 ConversationMessage.contentCompleteness 对齐：
 * 'full' / undefined = Live 完整原文；'preview' = 缓存截断文本。
 */
export interface HandoffTurnSnapshot {
  id: string

  index: number

  userText: string

  assistantText: string | null

  userCompleteness?: 'full' | 'preview'

  assistantCompleteness?: 'full' | 'preview'
}

export type ConversationHealthLevel = 'healthy' | 'watch' | 'organize' | 'new-chat'

export type ConversationHealthConfidence = 'low' | 'medium' | 'high'

/**
 * 分析覆盖度：健康分只应被理解为"对已分析文本"的评估。
 * 缓存 hydrate 恢复的 turn 只有截断 preview 文本（contentCompleteness='preview'），
 * 覆盖不足时分数证据不足，UI 必须明示、且不得产生强换聊建议。
 */
export interface ConversationHealthCoverage {
  totalTurns: number

  /** Live DOM 解析出完整原文的 turn 数（含未标记的默认 full） */
  fullTextTurns: number

  /** 仅有缓存截断 preview 的 turn 数 */
  previewOnlyTurns: number

  /** 等于 fullTextTurns（语义别名，供诊断读数） */
  liveTurns: number

  /** fullTextTurns / max(1, totalTurns) */
  coverageRatio: number

  source: 'live' | 'mixed' | 'cache-preview'

  confidence: ConversationHealthConfidence
}

export interface ConversationHealthSignals {
  /** 对话长度压力：用户 turn 数、已索引 user 文本量、近期超长 prompt 的组合。0=低，1=高（user-only，不含 assistant 正文） */
  lengthPressure: number
  /** 方案反转 / 切换频率（强反转或弱动词+决策上下文）。0=低，1=高 */
  decisionChurn: number
  /** 用户纠错 / 要求重做频率。0=低，1=高 */
  correctionFrequency: number
  /** 近期主题相对前文的漂移程度。0=低，1=高 */
  topicDrift: number
  /** 跨轮指代 + "重复 × 语义摩擦"放大器。0=低，1=高 */
  referenceDependency: number
  /** 长 prompt / 多文件 / 代码块等复杂度压力。0=低，1=高 */
  complexityPressure: number
}

export interface ConversationHealthEvidence {
  turnCount: number
  /** 已索引的用户提问字符数（user-only，不含 assistant 正文） */
  indexedUserCharacters: number
  recentWindow: number
  correctionHits: number
  churnHits: number
  backwardReferenceHits: number
  repeatedPromptPairs: number
  recentFileReferences: number
  recentCodeBlocks: number
}

export interface ConversationHealthSnapshot {
  /** 0..100，越高越健康 */
  score: number
  /** 0..1，越高风险越高 */
  risk: number
  level: ConversationHealthLevel
  /** 分析置信度：缓存 preview 覆盖不足时为 low，UI 必须明示且不得给强建议 */
  confidence: ConversationHealthConfidence
  coverage: ConversationHealthCoverage
  signals: ConversationHealthSignals
  evidence: ConversationHealthEvidence
  /** 仅描述元数据级原因，绝不回显 prompt 正文 */
  reasons: string[]
  /** 给 UI 的非强制建议 */
  recommendation: string
  /** 评估只基于 TurnRail 已索引到的内容，不等于模型真实上下文状态 */
  basis: 'indexed-local-heuristic'
}

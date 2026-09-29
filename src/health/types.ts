export type ConversationHealthLevel = 'healthy' | 'watch' | 'organize' | 'new-chat'

export interface ConversationHealthSignals {
  /** 对话长度压力：turn 数、已索引文本量、近期超长 prompt 的组合。0=低，1=高 */
  lengthPressure: number
  /** 方案反转 / 切换频率。0=低，1=高 */
  decisionChurn: number
  /** 用户纠错 / 要求重做频率。0=低，1=高 */
  correctionFrequency: number
  /** 近期主题相对前文的漂移程度。0=低，1=高 */
  topicDrift: number
  /** 跨轮指代 + 近期重复的组合压力。0=低，1=高 */
  referenceDependency: number
  /** 长 prompt / 多文件 / 代码块等复杂度压力。0=低，1=高 */
  complexityPressure: number
}

export interface ConversationHealthEvidence {
  turnCount: number
  indexedCharacters: number
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
  signals: ConversationHealthSignals
  evidence: ConversationHealthEvidence
  /** 仅描述元数据级原因，绝不回显 prompt 正文 */
  reasons: string[]
  /** 给 UI 的非强制建议 */
  recommendation: string
  /** 评估只基于 TurnRail 已索引到的内容，不等于模型真实上下文状态 */
  basis: 'indexed-local-heuristic'
}

import type { ConversationTurn } from '../conversation/types'
import type {
  ConversationHealthConfidence,
  ConversationHealthCoverage,
  ConversationHealthEvidence,
  ConversationHealthLevel,
  ConversationHealthSignals,
  ConversationHealthSnapshot
} from './types'

const RECENT_WINDOW = 12
const TOPIC_RECENT_WINDOW = 5
const TOPIC_HISTORY_WINDOW = 20
const REPETITION_WINDOW = 8
const MAX_TEXT_PER_TURN = 24_000
// 中英文 token 配额分离：避免英文为主的 prompt 先塞满配额、丢掉中文主题信息
const MAX_LATIN_UNITS = 450
const MAX_CJK_UNITS = 450

/**
 * 风险权重：R = .30L + .20D + .20C + .15T + .10Rd + .05F。
 * 集中定义（避免 magic numbers 散落），单测保证 sum === 1。
 *
 * 由此得到的关键不变式：单一信号的最大贡献只有 0.30（L），因此加权分数
 * 本身不可能被单一信号单独压进 new-chat 区间 —— "单一指标不得触发换聊
 * 建议"由数学结构保证，等级 guardrail（deriveHealthLevel）只做收紧。
 */
export const HEALTH_WEIGHTS = {
  lengthPressure: 0.3,
  decisionChurn: 0.2,
  correctionFrequency: 0.2,
  topicDrift: 0.15,
  referenceDependency: 0.1,
  complexityPressure: 0.05
} as const

/**
 * 置信度与等级 guardrail 阈值（集中管理；校准以 test/unit/healthCases.ts
 * 的 Golden Cases 为准，调整时必须同步跑 Golden Cases 测试）。
 */
export const HEALTH_THRESHOLDS = {
  /** full-text 覆盖率 ≥ 该值 → high confidence */
  confidenceHigh: 0.85,
  /** full-text 覆盖率 ≥ 该值 → medium confidence，否则 low */
  confidenceMedium: 0.5,
  /** 任一纠错/反转信号达到该值 → healthy 至少降为 watch */
  watchGateCorrection: 0.8,
  watchGateChurn: 0.8,
  /** 漂移/依赖类天然波动更大，gate 更高 */
  watchGateTopicDrift: 0.85,
  watchGateReference: 0.85,
  /** organize / new-chat 要求的"核心信号高值"判定线与最少数量 */
  coreHigh: 0.6,
  organizeMinCore: 1,
  newChatMinCore: 2
} as const

// 纠错信号只认"用户在纠正模型 / 要求重做"的表达，不认话题词：
// - 裸 `错误` 会命中"错误处理""报错信息"这类调试话题，裸 `wrong` 会命中
//   "what's wrong with X" 这类设计提问，均已在审查中排除（避免单轮误判）；
// - `修正` 会命中"修正 README 拼写"这类普通任务请求，同样排除。
const CORRECTION_RE =
  /(不对|错了|有误|理解错|搞错|说错|你理解错|重新来|重新做|重做|纠正|还是不对|仍然不对|并不是|not right|that's wrong|this is wrong|you're wrong|still wrong|incorrect|mistake|redo|do it again|fix this|you misunderstood)/i

// 方案反转两级判定（P1-3 降误报）：
// - Strong：明确推翻 / 放弃既有决策，直接命中；
// - Weak（改成/换成/切换到 等普通修改动词）必须与决策上下文同句出现，
//   否则"把按钮改成绿色""把 padding 改成 8px"这类正常开发会被误计。
const STRONG_CHURN_RE =
  /(不要用之前|不用之前|放弃之前|取消之前|撤销之前|推翻之前|回滚到|换一个方案|换方案|改变方向|换思路|不用这个方案|不用这个思路|drop the previous|revert the decision|discard the previous|switch away from|abandon the previous|roll back)/i
const WEAK_CHANGE_RE =
  /(改成|改为|换成|切换到|改用|instead|switch to|change to|rather than|actually use)/i
const DECISION_CONTEXT_RE =
  /(之前|此前|原来|原方案|原计划|当前方案|方案|架构|设计方向|实现路线|技术选型|决定|approach|architecture|design|previous|original plan|decision)/i

const BACKWARD_REF_RE =
  /(之前|前面|上面|刚才|沿用|继续之前|基于之前|按照之前|前文|上一轮|前几轮|如前所述|same as before|previous|earlier|above|as before|continue from)/i

const FILE_REF_RE =
  /(?:^|[\s"'“”‘’(（])[^\s"'“”‘’()（）]{1,120}\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|py|json|ya?ml|toml|csv|xlsx?|docx?|pdf|pptx?|html?|css|scss|sql|ipynb|java|cpp|c|h|go|rs)(?=$|[\s"'“”‘’),，。；;:：）])/gi

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function scale(value: number, low: number, high: number): number {
  if (high <= low) return value >= high ? 1 : 0
  return clamp01((value - low) / (high - low))
}

function round3(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000
}

function userText(turn: ConversationTurn): string {
  return (turn.user?.text ?? '').slice(0, MAX_TEXT_PER_TURN)
}

function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lexicalUnits(text: string): Set<string> {
  const normalized = normalizeForSimilarity(text)
  const out = new Set<string>()

  const latin = normalized.match(/[a-z0-9_+-]{2,}/g) ?? []
  for (const token of latin) {
    out.add(token)
    if (out.size >= MAX_LATIN_UNITS) break
  }

  // 中文按"连续汉字段"内生成 bigram（P1-6）：此前实现把全部汉字拼接成
  // 一个字符串，跨标点 / 跨句产生人工相邻词（如"缓存。重启"→`存重`），
  // 污染主题相似度。
  const cjkSegments = normalized.match(/[\u3400-\u9fff]+/g) ?? []
  let cjkUnits = 0
  for (const segment of cjkSegments) {
    for (let i = 0; i < segment.length - 1; i++) {
      out.add(segment.slice(i, i + 2))
      cjkUnits++
      if (cjkUnits >= MAX_CJK_UNITS) return out
    }
  }

  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union > 0 ? intersection / union : 0
}

function countMatchingTurns(texts: readonly string[], regex: RegExp): number {
  let count = 0
  for (const text of texts) {
    regex.lastIndex = 0
    if (regex.test(text)) count++
  }
  return count
}

/** 方案反转判定：强反转直接命中；弱修改动词必须伴随决策上下文（P1-3） */
function isDecisionChurn(text: string): boolean {
  if (STRONG_CHURN_RE.test(text)) return true
  return WEAK_CHANGE_RE.test(text) && DECISION_CONTEXT_RE.test(text)
}

function countFileReferences(texts: readonly string[]): number {
  let count = 0
  for (const text of texts) {
    FILE_REF_RE.lastIndex = 0
    count += text.match(FILE_REF_RE)?.length ?? 0
  }
  return count
}

function countCodeBlocks(texts: readonly string[]): number {
  let count = 0
  for (const text of texts) {
    const fences = text.match(/```/g)?.length ?? 0
    count += Math.floor(fences / 2)
  }
  return count
}

function topicDriftScore(userTexts: readonly string[]): number {
  if (userTexts.length < 8) return 0

  const recent = userTexts.slice(-TOPIC_RECENT_WINDOW)
  const history = userTexts.slice(
    Math.max(0, userTexts.length - TOPIC_HISTORY_WINDOW),
    -TOPIC_RECENT_WINDOW
  )
  if (history.length < 3) return 0

  const recentUnits = lexicalUnits(recent.join(' '))
  const historyUnits = lexicalUnits(history.join(' '))
  if (recentUnits.size < 8 || historyUnits.size < 8) return 0

  const similarity = jaccard(recentUnits, historyUnits)
  // 自然主题变化不应直接判高风险；只有重合度非常低时才逐渐增加压力。
  return scale(0.34 - similarity, 0, 0.28)
}

function repetitionScore(userTexts: readonly string[]): { score: number; pairs: number } {
  const recent = userTexts.slice(-REPETITION_WINDOW).filter((text) => normalizeForSimilarity(text).length >= 12)
  if (recent.length < 3) return { score: 0, pairs: 0 }

  const sets = recent.map(lexicalUnits)
  let repeatedPairs = 0
  let maxSimilarity = 0

  for (let i = 1; i < sets.length; i++) {
    for (let j = 0; j < i; j++) {
      const sim = jaccard(sets[i]!, sets[j]!)
      maxSimilarity = Math.max(maxSimilarity, sim)
      if (sim >= 0.58) repeatedPairs++
    }
  }

  const density = scale(repeatedPairs, 0, 4)
  const peak = scale(maxSimilarity, 0.55, 0.9)
  return { score: clamp01(density * 0.65 + peak * 0.35), pairs: repeatedPairs }
}

/**
 * 覆盖度 / 置信度（P0-2）：缓存 hydrate 恢复的 turn 只带截断 preview 文本
 * （contentCompleteness='preview'），对它们分析出的分数证据不足。
 * Live DOM 解析的 turn 由 Indexer 标记 'full'（或未标记，默认 full）。
 */
function buildCoverage(turns: readonly ConversationTurn[]): ConversationHealthCoverage {
  const userTurns = turns.filter((turn) => turn.user)
  const previewOnlyTurns = userTurns.filter(
    (turn) => turn.user?.contentCompleteness === 'preview'
  ).length
  const fullTextTurns = userTurns.length - previewOnlyTurns
  const totalTurns = userTurns.length
  const coverageRatio = totalTurns === 0 ? 1 : fullTextTurns / totalTurns
  const source: ConversationHealthCoverage['source'] =
    previewOnlyTurns === 0 ? 'live' : fullTextTurns === 0 ? 'cache-preview' : 'mixed'
  const confidence: ConversationHealthConfidence =
    coverageRatio >= HEALTH_THRESHOLDS.confidenceHigh
      ? 'high'
      : coverageRatio >= HEALTH_THRESHOLDS.confidenceMedium
        ? 'medium'
        : 'low'
  return {
    totalTurns,
    fullTextTurns,
    previewOnlyTurns,
    liveTurns: fullTextTurns,
    coverageRatio: Math.round(coverageRatio * 1000) / 1000,
    source,
    confidence
  }
}

function scoreLevel(score: number): ConversationHealthLevel {
  if (score >= 80) return 'healthy'
  if (score >= 65) return 'watch'
  if (score >= 45) return 'organize'
  return 'new-chat'
}

/**
 * 建议等级 = 分数初判 + 信号 guardrail + 置信度 guard（P1-5 / P0-2）。
 *
 * score 是连续量（加权平均，会把单信号稀释），等级是给用户的建议 ——
 * 两者刻意解耦：
 * - healthy 要求无任何核心信号进入强区间（"12 轮全在纠错但分数 80"不得显示 healthy）；
 * - organize / new-chat 要求核心语义信号（纠错/反转/漂移/依赖）实质支持；
 * - 低置信度（缓存 preview 覆盖不足）不得输出强换聊建议，证据不足时最多 watch。
 */
function deriveHealthLevel(
  score: number,
  signals: ConversationHealthSignals,
  confidence: ConversationHealthConfidence
): ConversationHealthLevel {
  let level = scoreLevel(score)

  if (level === 'healthy') {
    const strongSignal =
      signals.correctionFrequency >= HEALTH_THRESHOLDS.watchGateCorrection ||
      signals.decisionChurn >= HEALTH_THRESHOLDS.watchGateChurn ||
      signals.topicDrift >= HEALTH_THRESHOLDS.watchGateTopicDrift ||
      signals.referenceDependency >= HEALTH_THRESHOLDS.watchGateReference
    if (strongSignal) level = 'watch'
  }

  if (level === 'organize' || level === 'new-chat') {
    const coreHighCount = [
      signals.correctionFrequency,
      signals.decisionChurn,
      signals.topicDrift,
      signals.referenceDependency
    ].filter((value) => value >= HEALTH_THRESHOLDS.coreHigh).length
    if (level === 'organize' && coreHighCount < HEALTH_THRESHOLDS.organizeMinCore) level = 'watch'
    if (level === 'new-chat' && coreHighCount < HEALTH_THRESHOLDS.newChatMinCore) level = 'organize'
  }

  if (confidence === 'low' && level === 'new-chat') level = 'watch'
  return level
}

function recommendationFor(level: ConversationHealthLevel): string {
  switch (level) {
    case 'healthy':
      return '当前对话可继续。'
    case 'watch':
      return '可以继续，但建议在阶段节点整理关键结论与约束。'
    case 'organize':
      return '建议先整理当前阶段结论；若任务已切换阶段，优先新开聊天继续。'
    case 'new-chat':
      return '建议考虑新开聊天，并带上目标、已确认结论、约束、当前状态、待决问题和关键文件/代码链接。'
  }
}

function buildReasons(
  signals: ConversationHealthSignals,
  evidence: ConversationHealthEvidence
): string[] {
  const candidates: Array<{ score: number; text: string }> = [
    {
      score: signals.lengthPressure,
      text: `已分析 ${evidence.turnCount} 轮用户提问，约 ${Math.round(evidence.indexedUserCharacters / 1000)}k 字符`
    },
    {
      score: signals.correctionFrequency,
      text: `最近 ${evidence.recentWindow} 轮出现 ${evidence.correctionHits} 次纠错/重做表达`
    },
    {
      score: signals.decisionChurn,
      text: `最近 ${evidence.recentWindow} 轮出现 ${evidence.churnHits} 次方案切换/反转表达`
    },
    {
      score: signals.topicDrift,
      text: '近期问题与前文主题词重合度较低'
    },
    {
      score: signals.referenceDependency,
      text:
        evidence.backwardReferenceHits > 0
          ? `最近 ${evidence.recentWindow} 轮有 ${evidence.backwardReferenceHits} 次明显跨轮指代或重复依赖`
          : '近期问题存在较高重复度'
    },
    {
      score: signals.complexityPressure,
      text: `近期提示较长，并引用约 ${evidence.recentFileReferences} 个文件名 / ${evidence.recentCodeBlocks} 个代码块`
    }
  ]

  return candidates
    .filter((item) => item.score >= 0.28)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.text)
}

/**
 * TurnRail 本地启发式健康评估。
 *
 * 重要边界：
 * - 不调用模型 / API，不做网络请求；
 * - 不声称知道 ChatGPT 的真实 context window、内部裁剪或 Memory 状态；
 * - 只读取当前 Runtime Store 已索引到的 user prompt（user-only：assistant
 *   正文不参与主评分，避免流式期间的语义不一致）；
 * - 输出纯数值与元数据级原因，绝不回显 prompt 正文；
 * - 不以固定轮数单独决定是否换聊，轮数只是长度压力的一部分；
 * - 附带 coverage / confidence：缓存 preview 覆盖不足时分数仅供参考，
 *   低置信度绝不产生"建议新开聊天"这类强结论。
 */
export function analyzeConversationHealth(
  turns: readonly ConversationTurn[]
): ConversationHealthSnapshot {
  const coverage = buildCoverage(turns)

  const userTexts = turns.map(userText).filter(Boolean)
  const indexedUserCharacters = userTexts.reduce((sum, text) => sum + text.length, 0)

  const recentUserTexts = userTexts.slice(-RECENT_WINDOW)
  const correctionHits = countMatchingTurns(recentUserTexts, CORRECTION_RE)
  const churnHits = countByPredicate(recentUserTexts, isDecisionChurn)
  const backwardReferenceHits = countMatchingTurns(recentUserTexts, BACKWARD_REF_RE)
  const recentFileReferences = countFileReferences(recentUserTexts)
  const recentCodeBlocks = countCodeBlocks(recentUserTexts)
  const repetition = repetitionScore(userTexts)

  const averageRecentLength =
    recentUserTexts.length > 0
      ? recentUserTexts.reduce((sum, text) => sum + text.length, 0) / recentUserTexts.length
      : 0
  const maxRecentLength = recentUserTexts.reduce((max, text) => Math.max(max, text.length), 0)

  // user-only 长度压力（P0-1）：assistant 正文不参与 —— 流式期间健康分不重算，
  // 若长度计入 assistant 正文，同一回答在 5% 与 100% 生成进度下的底层输入不一致。
  // 字符量阈值按 user-only 口径重新校准（6k → 60k）。
  const lengthPressure = clamp01(
    scale(userTexts.length, 18, 75) * 0.48 +
      scale(indexedUserCharacters, 6_000, 60_000) * 0.42 +
      scale(maxRecentLength, 3_000, 14_000) * 0.1
  )
  const correctionFrequency = clamp01(
    scale(correctionHits, 0.5, 4) * (recentUserTexts.length >= 5 ? 1 : 0.55)
  )
  const decisionChurn = clamp01(
    scale(churnHits, 0.5, 4) * (recentUserTexts.length >= 5 ? 1 : 0.55)
  )
  const topicDrift = topicDriftScore(userTexts)
  const longRangeDependency = clamp01(
    scale(backwardReferenceHits, 1, 5) * (0.55 + lengthPressure * 0.45)
  )
  // 重复是放大器而非独立惩罚（P1-4）：稳定讨论同一模块自然会高重复；
  // 只有"重复 + 同时在纠错 / 反转 / 强依赖前文"才说明在反复重新解释上下文。
  const repetitionStress =
    repetition.score * Math.max(correctionFrequency, longRangeDependency, decisionChurn)
  const referenceDependency = clamp01(longRangeDependency * 0.75 + repetitionStress * 0.25)
  const complexityPressure = clamp01(
    scale(averageRecentLength, 900, 4_500) * 0.5 +
      scale(recentFileReferences, 1, 8) * 0.3 +
      scale(recentCodeBlocks, 1, 5) * 0.2
  )

  const signals: ConversationHealthSignals = {
    lengthPressure: round3(lengthPressure),
    decisionChurn: round3(decisionChurn),
    correctionFrequency: round3(correctionFrequency),
    topicDrift: round3(topicDrift),
    referenceDependency: round3(referenceDependency),
    complexityPressure: round3(complexityPressure)
  }

  // 风险 = 六信号加权和（权重见 HEALTH_WEIGHTS，和为 1）
  const risk = clamp01(
    signals.lengthPressure * HEALTH_WEIGHTS.lengthPressure +
      signals.decisionChurn * HEALTH_WEIGHTS.decisionChurn +
      signals.correctionFrequency * HEALTH_WEIGHTS.correctionFrequency +
      signals.topicDrift * HEALTH_WEIGHTS.topicDrift +
      signals.referenceDependency * HEALTH_WEIGHTS.referenceDependency +
      signals.complexityPressure * HEALTH_WEIGHTS.complexityPressure
  )
  const score = Math.round((1 - risk) * 100)
  const level = deriveHealthLevel(score, signals, coverage.confidence)

  const evidence: ConversationHealthEvidence = {
    turnCount: userTexts.length,
    indexedUserCharacters,
    recentWindow: Math.min(RECENT_WINDOW, recentUserTexts.length),
    correctionHits,
    churnHits,
    backwardReferenceHits,
    repeatedPromptPairs: repetition.pairs,
    recentFileReferences,
    recentCodeBlocks
  }

  return {
    score,
    risk: Math.round(risk * 1000) / 1000,
    level,
    confidence: coverage.confidence,
    coverage,
    signals,
    evidence,
    reasons: buildReasons(signals, evidence),
    recommendation: recommendationFor(level),
    basis: 'indexed-local-heuristic'
  }
}

function countByPredicate(texts: readonly string[], predicate: (text: string) => boolean): number {
  let count = 0
  for (const text of texts) {
    if (predicate(text)) count++
  }
  return count
}

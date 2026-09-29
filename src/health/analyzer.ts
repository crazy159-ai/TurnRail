import type { ConversationTurn } from '../conversation/types'
import type {
  ConversationHealthEvidence,
  ConversationHealthLevel,
  ConversationHealthSignals,
  ConversationHealthSnapshot
} from './types'

const RECENT_WINDOW = 12
const TOPIC_RECENT_WINDOW = 5
const MAX_TEXT_PER_TURN = 24_000
const MAX_LEXICAL_UNITS = 900

// 纠错信号只认"用户在纠正模型 / 要求重做"的表达，不认话题词：
// - 裸 `错误` 会命中"错误处理""报错信息"这类调试话题，裸 `wrong` 会命中
//   "what's wrong with X" 这类设计提问，均已在审查中排除（避免单轮误判）；
// - `修正` 会命中"修正 README 拼写"这类普通任务请求，同样排除。
const CORRECTION_RE =
  /(不对|错了|有误|理解错|搞错|说错|你理解错|重新来|重新做|重做|纠正|还是不对|仍然不对|并不是|not right|that's wrong|this is wrong|you're wrong|still wrong|incorrect|mistake|redo|do it again|fix this|you misunderstood)/i

const CHURN_RE =
  /(改成|改为|换成|切换到|不要用|不用了|取消之前|撤销|回滚|推翻|之前.*现在|现在改|instead|switch to|change to|rather than|actually use|revert|roll back|drop the previous)/i

const BACKWARD_REF_RE =
  /(之前|前面|上面|刚才|沿用|继续之前|基于之前|按照之前|前文|上一轮|前几轮|如前所述|same as before|previous|earlier|above|as before|continue from)/i

const FILE_REF_RE =
  /(?:^|[\s"'“”‘’(（])[^\s"'“”‘’()（）]{1,120}\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|py|json|ya?ml|toml|csv|xlsx?|docx?|pdf|pptx?|html?|css|scss|sql|ipynb|java|cpp|c|h|go|rs)(?=$|[\s"'“”‘’),，。；;:：）])/gi

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * 风险权重：R = .30L + .20D + .20C + .15T + .10Rd + .05F。
 * 集中定义（避免 magic numbers 散落），单测保证 sum === 1。
 *
 * 由此得到的关键不变式：单一信号的最大贡献只有 0.30（L），因此即使某一
 * 信号拉满（如 80 轮超长但稳定的对话），分数也不可能单独落入 new-chat
 * 区间（score ≥ 70 ≥ watch 下限）——"单一指标不得触发换聊建议"由数学
 * 结构保证，不依赖额外 guard 代码。
 */
export const HEALTH_WEIGHTS = {
  lengthPressure: 0.3,
  decisionChurn: 0.2,
  correctionFrequency: 0.2,
  topicDrift: 0.15,
  referenceDependency: 0.1,
  complexityPressure: 0.05
} as const

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

function assistantText(turn: ConversationTurn): string {
  return (turn.assistant?.text ?? '').slice(0, MAX_TEXT_PER_TURN)
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
    if (out.size >= MAX_LEXICAL_UNITS) return out
  }

  const cjk = (normalized.match(/[\u3400-\u9fff]/g) ?? []).join('')
  for (let i = 0; i < cjk.length - 1; i++) {
    out.add(cjk.slice(i, i + 2))
    if (out.size >= MAX_LEXICAL_UNITS) return out
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

function countMatches(texts: readonly string[], regex: RegExp): number {
  let count = 0
  for (const text of texts) {
    regex.lastIndex = 0
    if (regex.test(text)) count++
  }
  return count
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
  const history = userTexts.slice(Math.max(0, userTexts.length - 20), -TOPIC_RECENT_WINDOW)
  if (history.length < 3) return 0

  const recentUnits = lexicalUnits(recent.join(' '))
  const historyUnits = lexicalUnits(history.join(' '))
  if (recentUnits.size < 8 || historyUnits.size < 8) return 0

  const similarity = jaccard(recentUnits, historyUnits)
  // 自然主题变化不应直接判高风险；只有重合度非常低时才逐渐增加压力。
  return scale(0.34 - similarity, 0, 0.28)
}

function repetitionScore(userTexts: readonly string[]): { score: number; pairs: number } {
  const recent = userTexts.slice(-8).filter((text) => normalizeForSimilarity(text).length >= 12)
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

function healthLevel(score: number): ConversationHealthLevel {
  if (score >= 80) return 'healthy'
  if (score >= 65) return 'watch'
  if (score >= 45) return 'organize'
  return 'new-chat'
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
      return '建议新开聊天，并带上目标、已确认结论、约束、当前状态、待决问题和关键文件/代码链接。'
  }
}

function buildReasons(
  signals: ConversationHealthSignals,
  evidence: ConversationHealthEvidence
): string[] {
  const candidates: Array<{ score: number; text: string }> = [
    {
      score: signals.lengthPressure,
      text: `已索引 ${evidence.turnCount} 轮，文本约 ${Math.round(evidence.indexedCharacters / 1000)}k 字符`
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
 * - 只读取当前 Runtime Store 已索引到的文本，输出纯数值与元数据级原因；
 * - 不以固定轮数单独决定是否换聊，轮数只是长度压力的一部分。
 */
export function analyzeConversationHealth(
  turns: readonly ConversationTurn[]
): ConversationHealthSnapshot {
  const userTexts = turns.map(userText).filter(Boolean)
  const assistantTexts = turns.map(assistantText).filter(Boolean)
  const indexedCharacters =
    userTexts.reduce((sum, text) => sum + text.length, 0) +
    assistantTexts.reduce((sum, text) => sum + text.length, 0)

  const recentUserTexts = userTexts.slice(-RECENT_WINDOW)
  const correctionHits = countMatches(recentUserTexts, CORRECTION_RE)
  const churnHits = countMatches(recentUserTexts, CHURN_RE)
  const backwardReferenceHits = countMatches(recentUserTexts, BACKWARD_REF_RE)
  const recentFileReferences = countFileReferences(recentUserTexts)
  const recentCodeBlocks = countCodeBlocks(recentUserTexts)
  const repetition = repetitionScore(userTexts)

  const averageRecentLength =
    recentUserTexts.length > 0
      ? recentUserTexts.reduce((sum, text) => sum + text.length, 0) / recentUserTexts.length
      : 0
  const maxRecentLength = recentUserTexts.reduce((max, text) => Math.max(max, text.length), 0)

  const lengthPressure = clamp01(
    scale(userTexts.length, 18, 75) * 0.48 +
      scale(indexedCharacters, 30_000, 180_000) * 0.42 +
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
  const referenceDependency = clamp01(longRangeDependency * 0.62 + repetition.score * 0.38)
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
  const level = healthLevel(score)

  const evidence: ConversationHealthEvidence = {
    turnCount: userTexts.length,
    indexedCharacters,
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
    signals,
    evidence,
    reasons: buildReasons(signals, evidence),
    recommendation: recommendationFor(level),
    basis: 'indexed-local-heuristic'
  }
}

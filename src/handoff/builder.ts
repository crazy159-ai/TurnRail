import { formatConversationHandoff } from './formatter'
import { HANDOFF_LIMITS } from './types'
import type {
  ConversationHandoff,
  HandoffBuildInput,
  HandoffSection,
  HandoffTurnSnapshot
} from './types'

/**
 * Conversation Handoff 构建器（纯函数，规格 #25）：
 * 不访问 DOM / chrome.storage / UI / tab —— 输入是调用方在用户点击
 * "Create Handoff" 时同步复制的 Store 快照，输出是结构化 handoff。
 *
 * 内容选取（V1，确定性，无 AI 摘要）：
 *   Selected Checkpoints + Recent Tail + Current Objective
 *
 * 超限处理（规格 #30，优先级 = checkpoint > 目标轮 user 文本 >
 * recent user > recent assistant，裁剪顺序相反）：
 *   1. 逐条消息先按 maxSingleMessageCharacters fence 安全截断；
 *   2. 全局超 maxCharacters 时先整段丢弃最旧的 recent turn（warning）；
 *   3. 再按裁剪优先级逐条收缩文本（fence 安全，warning）；
 *   每一步都产生 warning，绝不静默截断，绝不产生未闭合代码块。
 */

/** 预算收缩时每条文本保底保留的字符数（保证收缩循环终止） */
const MIN_KEEP_CHARS = 120

/** fence 安全截断：截断后统计 ``` 出现次数，奇数则补闭合 fence，绝不让代码块泄漏 */
export function truncateFenceSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n…[truncated by TurnRail local handoff limit]'
  const keep = Math.max(0, maxChars - marker.length)
  let cut = text.slice(0, keep)
  const fenceCount = (cut.match(/```/g) ?? []).length
  if (fenceCount % 2 === 1) cut += '\n```'
  return cut + marker
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function sectionFromTurn(turn: HandoffTurnSnapshot, kind: HandoffSection['kind']): HandoffSection {
  return {
    kind,
    turnNumber: turn.index + 1,
    userText: turn.userText,
    assistantText: hasText(turn.assistantText) ? turn.assistantText! : null,
    assistantCompleteness: turn.assistantCompleteness === 'preview' ? 'preview' : undefined,
    userCompleteness: turn.userCompleteness === 'preview' ? 'preview' : undefined
  }
}

function applyPerMessageCap(
  sections: HandoffSection[],
  maxSingle: number
): { checkpointTruncated: number; recentTruncated: number } {
  let checkpointTruncated = 0
  let recentTruncated = 0
  for (const section of sections) {
    if (section.userText.length > maxSingle) {
      section.userText = truncateFenceSafe(section.userText, maxSingle)
      if (section.kind === 'checkpoint') checkpointTruncated++
      else recentTruncated++
    }
    if (section.assistantText && section.assistantText.length > maxSingle) {
      section.assistantText = truncateFenceSafe(section.assistantText, maxSingle)
      if (section.kind === 'checkpoint') checkpointTruncated++
      else recentTruncated++
    }
  }
  return { checkpointTruncated, recentTruncated }
}

function countPreviewSections(sections: readonly HandoffSection[]): number {
  return sections.filter(
    (section) => section.assistantCompleteness === 'preview' || section.userCompleteness === 'preview'
  ).length
}

export function buildConversationHandoff(input: HandoffBuildInput): ConversationHandoff {
  const limits = { ...HANDOFF_LIMITS, ...input.limits }
  const warnings: string[] = []

  const turns = [...input.turns].sort((a, b) => a.index - b.index)
  const turnById = new Map(turns.map((turn) => [turn.id, turn]))
  const userTurns = turns.filter((turn) => hasText(turn.userText))

  // ---------- 1. Selected checkpoints（最高优先级；superseded 永不进入） ----------
  const activeCheckpoints = [...input.checkpoints]
    .filter((checkpoint) => checkpoint.status !== 'superseded')
    .sort((a, b) => a.turnIndex - b.turnIndex)

  // 超限保留最新 N 个：长期任务的最新工作状态最有价值，被省略的永远是最旧的
  //（Release Candidate 策略；formatter 仍按旧 → 新渲染 retained）
  const retainedCheckpoints =
    activeCheckpoints.length > limits.maxCheckpoints
      ? activeCheckpoints.slice(-limits.maxCheckpoints)
      : activeCheckpoints
  const omittedCheckpoints = activeCheckpoints.length - retainedCheckpoints.length

  const checkpointSections: HandoffSection[] = []
  const checkpointTurnIds = new Set<string>()
  let unresolvedCheckpoints = 0
  for (const checkpoint of retainedCheckpoints) {
    const turn = turnById.get(checkpoint.turnId)
    if (!turn) {
      // 标记后 Store 被重置 / stale 清理：宁可丢弃并明示，也不输出错位内容
      unresolvedCheckpoints++
      continue
    }
    checkpointTurnIds.add(checkpoint.turnId)
    checkpointSections.push(sectionFromTurn(turn, 'checkpoint'))
  }
  if (omittedCheckpoints > 0) {
    warnings.push(
      `${omittedCheckpoints} older selected checkpoint(s) were omitted to fit the local checkpoint limit (${limits.maxCheckpoints}); the most recent checkpoints are retained.`
    )
  }
  if (unresolvedCheckpoints > 0) {
    warnings.push(
      `${unresolvedCheckpoints} checkpoint(s) could not be resolved in the current conversation state and were skipped.`
    )
  }

  // ---------- 2. Current objective（最后一个 user prompt，不重写含义） ----------
  const objectiveTurn = userTurns[userTurns.length - 1]
  if (!objectiveTurn) {
    return {
      schemaVersion: 1,
      generatedAt: Date.now(),
      source: {
        conversationIdAvailable: input.conversationId !== null,
        totalUserTurns: 0,
        selectedTurns: 0,
        checkpointCount: 0
      },
      health: input.health,
      sections: [],
      warnings: ['No indexed user turns were available; only the continuation rules are included.']
    }
  }
  // objective 与 selected checkpoint 同轮：正文不重复（引用形态，同一 turn
  // 的完整 user/assistant 文本在最终 markdown 中只出现一次）
  const objectiveIsCheckpoint = checkpointTurnIds.has(objectiveTurn.id)
  let currentObjectiveReference: ConversationHandoff['currentObjectiveReference'] | undefined
  let objectiveSection: HandoffSection | null = null
  if (objectiveIsCheckpoint) {
    currentObjectiveReference = { checkpointTurnNumber: objectiveTurn.index + 1 }
  } else {
    objectiveSection = sectionFromTurn(objectiveTurn, 'objective')
  }

  // ---------- 3. Recent tail（目标轮之前、排除 checkpoint 轮，取最近 N 个） ----------
  const tailCandidates = userTurns.filter(
    (turn) => turn.index < objectiveTurn.index && !checkpointTurnIds.has(turn.id)
  )
  const tailSections = tailCandidates
    .slice(-limits.maxRecentTurns)
    .map((turn) => sectionFromTurn(turn, 'recent'))

  // ---------- 4. 覆盖度告警（preview 绝不伪装成完整文本） ----------
  const checkpointPreviews = countPreviewSections(checkpointSections)
  if (checkpointPreviews > 0) {
    warnings.push(
      `${checkpointPreviews} checkpoint message(s) are only available as truncated previews; load the full history and rebuild the handoff for complete text.`
    )
  }
  const recentPreviews = countPreviewSections(tailSections)
  if (recentPreviews > 0) {
    warnings.push(
      `${recentPreviews} recent message(s) are only available as truncated previews.`
    )
  }

  const assemble = (): HandoffSection[] =>
    objectiveSection
      ? [...checkpointSections, ...tailSections, objectiveSection]
      : [...checkpointSections, ...tailSections]

  const sections: HandoffSection[] = assemble()

  // ---------- 5. 逐条消息限额（fence 安全） ----------
  const capped = applyPerMessageCap(sections, limits.maxSingleMessageCharacters)
  if (capped.checkpointTruncated > 0) {
    warnings.push(
      `${capped.checkpointTruncated} selected checkpoint message(s) were truncated to fit the per-message handoff limit.`
    )
  }
  if (capped.recentTruncated > 0) {
    warnings.push(
      `${capped.recentTruncated} recent message(s) were truncated to fit the per-message handoff limit.`
    )
  }

  // ---------- 6. 全局字符预算（以最终 markdown 实测长度为准） ----------
  const draft: ConversationHandoff = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    source: {
      conversationIdAvailable: input.conversationId !== null,
      totalUserTurns: userTurns.length,
      selectedTurns: sections.length,
      checkpointCount: checkpointSections.length
    },
    health: input.health,
    sections,
    currentObjectiveReference,
    warnings
  }

  const measure = (): number => formatConversationHandoff(draft).length

  // 6a. 先整段丢弃最旧的 recent turn（checkpoint 与 objective 不动）
  let droppedRecent = 0
  while (tailSections.length > 0 && measure() > limits.maxCharacters) {
    tailSections.shift()
    draft.sections = assemble()
    draft.source.selectedTurns = draft.sections.length
    droppedRecent++
  }
  if (droppedRecent > 0) {
    warnings.push(
      `${droppedRecent} recent turn(s) were omitted to fit the local handoff size limit.`
    )
  }

  // 6b. 按裁剪优先级收缩文本（cut order = keep priority 的逆序）
  if (measure() > limits.maxCharacters) {
    const shrinkTargets: Array<{ section: HandoffSection; field: 'userText' | 'assistantText' }> = []
    for (const section of tailSections) {
      if (section.assistantText) shrinkTargets.push({ section, field: 'assistantText' })
    }
    if (objectiveSection) {
      if (objectiveSection.assistantText) {
        shrinkTargets.push({ section: objectiveSection, field: 'assistantText' })
      }
    }
    for (const section of tailSections) shrinkTargets.push({ section, field: 'userText' })
    if (objectiveSection) shrinkTargets.push({ section: objectiveSection, field: 'userText' })
    for (const section of checkpointSections) {
      if (section.assistantText) shrinkTargets.push({ section, field: 'assistantText' })
    }
    for (const section of checkpointSections) shrinkTargets.push({ section, field: 'userText' })

    let truncatedAny = false
    for (const target of shrinkTargets) {
      if (measure() <= limits.maxCharacters) break
      const current = target.section[target.field]
      if (!current) continue
      const overflow = measure() - limits.maxCharacters
      const nextMax = Math.max(MIN_KEEP_CHARS, current.length - overflow - 64)
      target.section[target.field] = truncateFenceSafe(current, nextMax)
      truncatedAny = true
    }
    if (truncatedAny) {
      warnings.push(
        'Some message(s) were truncated to fit the local handoff size limit.'
      )
    }
    if (measure() > limits.maxCharacters) {
      // 极端自定义限额下的保底：明确告知超限，绝不谎称符合预算
      warnings.push(
        'The handoff still exceeds the configured local size limit after truncation; review and trim before sending.'
      )
    }
  }

  return draft
}

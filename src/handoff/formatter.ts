import type { ConversationHandoff, HandoffSection } from './types'

/**
 * Handoff markdown 渲染（纯函数）：无 DOM / storage / 网络，输出可直接
 * 复制进 ChatGPT 输入框的确定性文本。全部内容以字符串拼接，
 * 绝不包含会话 UUID / turn id / URL（隐私合同，handoffBuilder.test 强制）。
 *
 * 预算控制发生在 builder（结构层）；formatter 只负责忠实渲染。
 */

/** 预览正文显式标注（绝不把缓存截断文本伪装成完整结论） */
const PREVIEW_NOTE =
  '*(preview only — full text was not available when this handoff was created)*'

export function formatConversationHandoff(handoff: ConversationHandoff): string {
  const lines: string[] = []

  lines.push('# TurnRail Context Handoff', '')
  lines.push(
    'This context was explicitly prepared by the user from a previous ChatGPT conversation.',
    ''
  )

  lines.push('## Continuation Rules', '')
  lines.push('- Treat the selected checkpoints below as the most important carried-forward state.')
  lines.push('- Do not assume omitted discussion is still authoritative.')
  lines.push('- If older context conflicts with a selected checkpoint, prefer the checkpoint.')
  lines.push('- Do not redo completed work unless required by the current task.')
  lines.push('- Distinguish confirmed decisions from unresolved questions.', '')

  lines.push('## Source', '')
  lines.push(`- User turns indexed: ${handoff.source.totalUserTurns}`)
  lines.push(`- Selected checkpoints: ${handoff.source.checkpointCount}`)
  if (handoff.health) {
    lines.push(`- Health assessment: ${handoff.health.level} (score ${handoff.health.score}/100)`)
    lines.push(`- Health confidence: ${handoff.health.confidence}`)
  }
  lines.push('')

  const checkpoints = handoff.sections.filter((section) => section.kind === 'checkpoint')
  if (checkpoints.length > 0) {
    lines.push('## Selected Checkpoints', '')
    checkpoints.forEach((section, index) => {
      pushSection(lines, section, `Checkpoint ${index + 1} — Turn ${section.turnNumber}`)
    })
  }

  const recent = handoff.sections.filter((section) => section.kind === 'recent')
  if (recent.length > 0) {
    lines.push('## Recent Working Context', '')
    recent.forEach((section) => {
      pushSection(lines, section, `Turn ${section.turnNumber}`)
    })
  }

  const objective = handoff.sections.find((section) => section.kind === 'objective')
  if (objective) {
    lines.push('## Current Objective', '')
    lines.push(objective.userText, '')
    if (objective.userCompleteness === 'preview') lines.push(PREVIEW_NOTE, '')
    if (objective.assistantText) {
      lines.push('#### Latest assistant reply', '')
      lines.push(objective.assistantText, '')
      if (objective.assistantCompleteness === 'preview') lines.push(PREVIEW_NOTE, '')
    }
  }

  if (handoff.warnings.length > 0) {
    lines.push('## Handoff Notes', '')
    for (const warning of handoff.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('## Next Action', '')
  lines.push('Continue from the state above.', '')

  return lines.join('\n')
}

function pushSection(lines: string[], section: HandoffSection, heading: string): void {
  lines.push(`### ${heading}`, '')
  lines.push('#### User', '', section.userText, '')
  if (section.userCompleteness === 'preview') lines.push(PREVIEW_NOTE, '')
  if (section.assistantText) {
    lines.push('#### Assistant', '', section.assistantText, '')
    if (section.assistantCompleteness === 'preview') lines.push(PREVIEW_NOTE, '')
  }
}

import type { ConversationStore } from './store'

/**
 * History Coverage（Passive History Harvest 模型）。
 *
 * coverage 只回答一个问题：TurnRail 当前实际掌握了多少内容。数据来源仅有三种：
 * 缓存 hydrate（preview）、用户自然浏览时的 Live DOM 被动收获（full）、
 * 用户显式点击「加载全部历史」的受控捕获（full + 到顶证据）。
 *
 * 产品硬性原则（BACKGROUND_TASK_MUST_NOT_SCROLL）：TurnRail 绝不为补全历史
 * 主动滚动当前聊天。coverage 是"观察结果"，不是"后台任务进度"。
 *
 * `state='complete'` 仅表示已确认到达当前会话视觉顶部且无更多旧 turn
 * （显式捕获确认 / 缓存 complete / 用户自然到顶且懒加载稳定的证据），
 * 绝不表示模型 context / OpenAI 服务端数据完整。
 */
export interface HistoryCoverage {
  indexedTurns: number

  fullUserTurns: number
  previewUserTurns: number

  fullAssistantTurns: number
  missingAssistantTurns: number

  reachedTop: boolean

  state: 'complete' | 'partial' | 'unknown'
}

export function computeHistoryCoverage(
  store: ConversationStore,
  reachedTop: boolean
): HistoryCoverage {
  const userTurns = store.turns.filter((turn) => turn.user)
  const previewUserTurns = userTurns.filter(
    (turn) => turn.user?.contentCompleteness === 'preview'
  ).length
  const withAssistant = userTurns.filter((turn) => turn.assistant)
  const fullAssistantTurns = withAssistant.filter(
    (turn) => turn.assistant?.contentCompleteness !== 'preview'
  ).length

  let state: HistoryCoverage['state']
  if (userTurns.length === 0) state = 'unknown'
  else if (reachedTop && previewUserTurns === 0) state = 'complete'
  else state = 'partial'

  return {
    // History 计数 == Outline 问题数（user turn 数，非全部 turn）：
    // assistant-only turn 不构成目录条目，也不该计入"历史 N"
    indexedTurns: userTurns.length,
    fullUserTurns: userTurns.length - previewUserTurns,
    previewUserTurns,
    fullAssistantTurns,
    missingAssistantTurns: userTurns.length - withAssistant.length,
    reachedTop,
    state
  }
}

/** 静态覆盖状态 → footer 低干扰文案（无正文；unknown / 空会话返回空串隐藏） */
export function historyCoverageLabel(coverage: HistoryCoverage): string {
  if (coverage.indexedTurns === 0 || coverage.state === 'unknown') return ''
  // complete 语义 = 已确认到达当前会话视觉顶部（reachedTop），
  // 不声称"所有正文已补全"（preview 补全仍可经自然浏览继续发生）
  const suffix = coverage.state === 'complete' ? '已到顶' : '部分'
  return `历史 ${coverage.indexedTurns} · ${suffix}`
}

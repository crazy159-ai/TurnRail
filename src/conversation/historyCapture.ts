import type { ChatProvider } from '../providers/types'
import type { ConversationIndexer } from '../conversation/indexer'
import type { ConversationStore } from '../conversation/store'
import { sleep } from '../utils/debounce'
import { captureScrollAnchor, restoreScrollAnchor } from '../navigation/scrollAnchor'
import { isAtVisualTop, moveTowardVisualTop } from '../navigation/scrollGeometry'

let captureRunning = false

export function isCaptureRunning(): boolean {
  return captureRunning
}

export interface CaptureResult {
  addedTurns: number
  /** 是否确认到达视觉顶部且无更多历史（缓存 complete 标记的唯一依据） */
  reachedTop: boolean
}

export interface CaptureOptions {
  /**
   * 会话过期检测（规格 #25/#26：generation 贯穿全部 async path）。
 * 每次循环迭代前调用；返回 true = 路由已切换，立即中止 —— 迟到的捕获
   * 绝不把旧会话 DOM 扫进新会话 Store，也绝不把旧阅读位置恢复到新容器。
   */
  isStale?: () => boolean
}

/**
 * Level 2 全量历史捕获（用户主动触发，不自动运行）：
 * 记录阅读位置 → 渐进向上滚动 → 等待懒加载 → 收获 → 到顶或无新增即停止 → 恢复阅读位置。
 * 有最大迭代次数 / 总超时 / 连续无新增终止条件，只写 scrollTop，不改 ChatGPT DOM。
 */
export async function captureFullHistory(
  provider: ChatProvider,
  indexer: ConversationIndexer,
  store: ConversationStore,
  onProgress?: (message: string) => void,
  options?: CaptureOptions
): Promise<CaptureResult> {
  if (captureRunning) return { addedTurns: -1, reachedTop: false }
  captureRunning = true
  try {
    return await runCapture(provider, indexer, store, onProgress, options)
  } finally {
    captureRunning = false
  }
}

async function runCapture(
  provider: ChatProvider,
  indexer: ConversationIndexer,
  store: ConversationStore,
  onProgress?: (message: string) => void,
  options?: CaptureOptions
): Promise<CaptureResult> {
  const container = provider.getScrollContainer()
  if (!container) return { addedTurns: 0, reachedTop: false }

  const baselineTurns = store.turns.length
  const savedAnchor = captureScrollAnchor(provider, store)
  const deadline = Date.now() + 45000
  const maxIters = 300

  let lastTopTurnId: string | undefined
  let noNewRounds = 0
  let reachedTop = false

  for (let i = 0; i < maxIters; i++) {
    if (Date.now() > deadline) break
    // 路由已切换：立即中止。跳过恢复滚动与收尾扫描 —— 旧会话的锚点 / DOM
    // 绝不影响新会话（isStale 由 bootstrap 以 conversationGeneration 实现）
    if (options?.isStale?.()) return { addedTurns: 0, reachedTop: false }

    indexer.scan()
    const topTurn = store.turns.find((turn) => turn.user?.element?.isConnected)
    const topId = topTurn?.id
    if (topId !== undefined && topId === lastTopTurnId) {
      noNewRounds++
    } else {
      noNewRounds = 0
      lastTopTurnId = topId
    }

    const atVisualTop = isAtVisualTop(container)
    if (atVisualTop && noNewRounds >= 2) {
      reachedTop = true
      break
    }

    const step = Math.max(240, Math.floor(container.clientHeight * 0.9))
    // 向视觉顶部（更旧历史）移动：column-reverse 下为更负的 scrollTop，
    // 由 moveTowardVisualTop 统一 clamp，不会因 scrollTop < 0 误判到顶
    moveTowardVisualTop(container, step)
    onProgress?.(`正在加载历史… 已索引 ${store.turns.length} 个问题`)
    await sleep(420)
  }

  indexer.scan()
  const addedTurns = Math.max(0, store.turns.length - baselineTurns)
  restoreScrollAnchor(provider, store, savedAnchor)
  indexer.scan()
  onProgress?.('')
  return { addedTurns, reachedTop }
}

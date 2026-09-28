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
  onProgress?: (message: string) => void
): Promise<CaptureResult> {
  if (captureRunning) return { addedTurns: -1 }
  captureRunning = true
  try {
    return await runCapture(provider, indexer, store, onProgress)
  } finally {
    captureRunning = false
  }
}

async function runCapture(
  provider: ChatProvider,
  indexer: ConversationIndexer,
  store: ConversationStore,
  onProgress?: (message: string) => void
): Promise<CaptureResult> {
  const container = provider.getScrollContainer()
  if (!container) return { addedTurns: 0 }

  const baselineTurns = store.turns.length
  const savedAnchor = captureScrollAnchor(provider, store)
  const deadline = Date.now() + 45000
  const maxIters = 300

  let lastTopTurnId: string | undefined
  let noNewRounds = 0

  for (let i = 0; i < maxIters; i++) {
    if (Date.now() > deadline) break

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
    if (atVisualTop && noNewRounds >= 2) break

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
  return { addedTurns }
}

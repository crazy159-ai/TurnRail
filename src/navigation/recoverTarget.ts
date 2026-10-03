import type { ChatProvider } from '../providers/types'
import type { ConversationIndexer } from '../conversation/indexer'
import type { ConversationStore } from '../conversation/store'
import { sleep } from '../utils/debounce'
import { captureScrollAnchor, restoreScrollAnchor } from './scrollAnchor'
import { jumpToTurn } from './jump'
import { isAtVisualBottom, isAtVisualTop, moveTowardVisualBottom, moveTowardVisualTop } from './scrollGeometry'

export type RecoverResult = 'jumped' | 'not-found' | 'busy'

export interface RecoverOptions {
  /**
   * 会话过期检测（规格 #25/#26：generation 贯穿全部 async path）。
   * 每次循环迭代前调用；返回 true = 路由已切换，立即中止 —— 迟到的恢复
   * 绝不把旧会话 DOM 扫进新会话 Store，也绝不把旧阅读位置恢复到新容器。
   */
  isStale?: () => boolean
}

let recoverRunning = false

/** DEBUG：最近一次恢复过程的迭代日志（诊断用） */
const recoverIterations: string[] = []

export function getRecoverLog(): string[] {
  return recoverIterations
}

export function isRecoverRunning(): boolean {
  return recoverRunning
}

/**
 * 目标 turn 未挂载时的受控恢复跳转：
 * 渐进滚动 → 等待 DOM 更新 → 收获新挂载 turn → 命中即跳转。
 * 带最大迭代次数 / 超时 / 边界终止条件，失败时恢复原阅读位置。
 */
export async function recoverAndJump(
  provider: ChatProvider,
  indexer: ConversationIndexer,
  store: ConversationStore,
  turnId: string,
  onProgress?: (message: string) => void,
  options?: RecoverOptions
): Promise<RecoverResult> {
  const turn = store.getTurn(turnId)
  if (!turn) return 'not-found'

  const mounted = indexer.findMountedTurn(turnId)
  if (mounted) {
    return jumpToTurn(provider, mounted) ? 'jumped' : 'not-found'
  }

  if (recoverRunning) return 'busy'
  recoverRunning = true
  try {
    const container = provider.getScrollContainer()
    if (!container) return 'not-found'

    const savedAnchor = captureScrollAnchor(provider, store)
    const deadline = Date.now() + 20000
    const maxIters = 60
    recoverIterations.length = 0

    // 方向判断：目标在首个已挂载 turn 之前 → 向上，否则向下
    const firstMounted = store.turns.find((t) => t.user?.element?.isConnected)
    let direction: 'up' | 'down' = 'up'
    if (firstMounted && turn.index > firstMounted.index) direction = 'down'

    for (let i = 0; i < maxIters; i++) {
      if (Date.now() > deadline) break
      // 路由已切换：立即中止，跳过恢复滚动与收尾扫描（规格 #26）
      if (options?.isStale?.()) return 'not-found'

      indexer.scan()
      const found = indexer.findMountedTurn(turnId)
      recoverIterations.push(
        `#${i} dir=${direction} top=${Math.round(container.scrollTop)} ` +
          `sh=${container.scrollHeight} found=${!!found} firstIdx=${firstMounted?.index ?? '?'}`
      )
      if (found) {
        jumpToTurn(provider, found)
        return 'jumped'
      }

      const step = Math.max(200, Math.floor(container.clientHeight * 0.85))
      // 统一经 ScrollGeometry 移动：column-reverse 下"向上" = scrollTop 更负，
      // 由 moveTowardVisualTop / clamp 处理，禁止各处自行 Math.max(0, ...)
      if (direction === 'up') moveTowardVisualTop(container, step)
      else moveTowardVisualBottom(container, step)

      onProgress?.(direction === 'up' ? '正在向上查找历史消息…' : '正在向下查找消息…')
      await sleep(380)

      // 边界终止（视觉语义，两坐标系统一）：已到端点仍未找到
      if (direction === 'up' && isAtVisualTop(container)) {
        indexer.scan()
        if (!indexer.findMountedTurn(turnId)) break
      }
      if (direction === 'down' && isAtVisualBottom(container)) {
        indexer.scan()
        if (!indexer.findMountedTurn(turnId)) break
      }
    }

    restoreScrollAnchor(provider, store, savedAnchor)
    indexer.scan()
    return 'not-found'
  } finally {
    recoverRunning = false
  }
}

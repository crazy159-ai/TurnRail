import type { ChatProvider, LocatedTurnRoot } from '../providers/types'

/**
 * 两层 Observer 架构（v1.2）：
 *
 *   Route Watcher → Root Watch（root 生命周期）→ Conversation Observer（turn 生命周期）
 *
 * RootWatch 只负责"等 conversation root 出现 / 通知 root 丢失"，不索引消息；
 * 找到 root 后立即断开 document 级监听 —— 正常状态绝不久远观察整个 document.body。
 */

/**
 * 短命 root 发现观察器：root 已存在则立即回调；否则 observe(document.body)
 * 直到 root 出现（ChatGPT 渲染必然产生 mutation）。超过 30 秒未出现则放弃，
 * 等下一次路由变化重新发现。返回 stop。
 */
export function watchConversationRoot(
  provider: Pick<ChatProvider, 'getConversationRoot'>,
  onRootFound: (root: HTMLElement) => void,
  onGiveUp?: () => void
): () => void {
  const existing = provider.getConversationRoot()
  if (existing) {
    onRootFound(existing)
    return () => {}
  }

  let stopped = false
  let ticks = 0
  const observer = new MutationObserver(() => {
    check()
  })
  const check = (): void => {
    if (stopped) return
    const root = provider.getConversationRoot()
    if (root) {
      stop()
      onRootFound(root)
    }
  }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    observer.disconnect()
    window.clearInterval(timer)
  }
  // 防御性兜底：正常由 mutation 驱动；每 500ms 轮询一次，30 秒后放弃
  const timer = window.setInterval(() => {
    ticks++
    if (ticks > 60) {
      stop()
      onGiveUp?.()
      return
    }
    check()
  }, 500)

  observer.observe(document.body, { childList: true, subtree: true })
  return stop
}

/**
 * conversation root 内的 scoped 观察器：只观察 root 子树的 childList + characterData，
 * 不含 attributes。root 被替换/移除（无路由变化的罕见情况）时通知 onRootLost。
 * 返回 disconnect。
 */
export function observeConversationTurns(
  root: HTMLElement,
  onRecords: (records: MutationRecord[]) => void,
  onRootLost: () => void
): () => void {
  let stopped = false
  const observer = new MutationObserver((records) => {
    if (stopped) return
    if (!root.isConnected) {
      stop()
      onRootLost()
      return
    }
    onRecords(records)
  })
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  const stop = (): void => {
    stopped = true
    observer.disconnect()
  }
  return stop
}

/** 供增量扫描的已知性检查等场景使用的轻量重导出（保持模块边界清晰） */
export type { LocatedTurnRoot }

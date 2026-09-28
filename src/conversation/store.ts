import type { ChangeKind, ConversationMessage, ConversationTurn, DetachedTurn } from './types'

export type StoreEvent = Exclude<ChangeKind, 'none'>
export type StoreListener = (kind: StoreEvent) => void

/**
 * 会话数据仓库：只存数据，不查 DOM、不依赖 UI。
 * UI 通过订阅事件 + 读取快照渲染。
 */
export class ConversationStore {
  conversationKey = ''
  messages = new Map<string, ConversationMessage>()
  turns: ConversationTurn[] = []
  activeTurnId: string | undefined = undefined

  /** 当前挂载消息的 id 顺序（scan 快路径对齐用） */
  visibleOrder: string[] = []
  /** 当前挂载消息的稳定 key 顺序（签名比较用） */
  lastVisibleKeys: string[] = []
  /** 已卸载但仍保留 metadata 的 turn */
  detached: DetachedTurn[] = []

  private listeners = new Set<StoreListener>()

  onChange(listener: StoreListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(kind: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(kind)
      } catch (err) {
        console.warn('[TurnRail] store listener 出错', err)
      }
    }
  }

  /** 路由切换：彻底清空，避免跨会话数据混合 */
  reset(conversationKey: string): void {
    this.conversationKey = conversationKey
    this.messages.clear()
    this.turns = []
    this.activeTurnId = undefined
    this.visibleOrder = []
    this.lastVisibleKeys = []
    this.detached = []
    this.emit('structure')
  }

  getTurn(id: string): ConversationTurn | undefined {
    return this.turns.find((turn) => turn.id === id)
  }

  /** 已挂载（元素在文档中）的首个 turn */
  firstMountedTurn(): ConversationTurn | undefined {
    return this.turns.find((turn) => (turn.user?.element ?? turn.assistant?.element)?.isConnected)
  }

  /** 内部使用：由 Indexer 在扫描后提交本轮结果并广播 */
  commit(kind: ChangeKind): void {
    if (kind !== 'none') this.emit(kind)
  }
}

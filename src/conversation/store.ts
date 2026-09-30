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
  /**
   * 当前会话包含来自导航缓存的 hydrated turn：true 期间 Indexer 的持续空扫描
   * 不清空 turns（缓存恢复的目录必须在 ChatGPT 历史挂载前存活）。
   * 仅由 cache/hydrator 置位；路由重置或缓存确认 stale 时清除。
   */
  cacheHydrated = false
  /**
   * 语义修订号：structure / user-text 事件递增，assistant-text / elements 不变。
   * 供健康分析等"只依赖 user prompt 语义"的派生状态做廉价变更检测，
   * 取代此前在 UI 侧拼接全文的 signature（重复 Store 已有信息、漏检早期 turn 修改）。
   * reset() 归零。
   */
  semanticRevision = 0

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
    this.cacheHydrated = false
    this.semanticRevision = 0
    this.emit('structure')
  }

  getTurn(id: string): ConversationTurn | undefined {
    return this.turns.find((turn) => turn.id === id)
  }

  /** 按当前 turns 顺序重排 index（0..n-1）；供缓存 hydrate / 清理复用 */
  reindexTurns(): void {
    this.turns.forEach((turn, index) => {
      turn.index = index
      if (turn.user) turn.user.turnIndex = index
      else if (turn.assistant) turn.assistant.turnIndex = index
    })
  }

  /** 移除指定 id 的 turn（缓存确认 stale 时清理 hydrated turn），保持 index 连续并广播 */
  dropTurns(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return
    const next = this.turns.filter((turn) => !ids.has(turn.id))
    if (next.length === this.turns.length) return
    this.turns = next
    this.detached = this.detached.filter((entry) => !ids.has(entry.turn.id))
    this.reindexTurns()
    if (this.activeTurnId && !next.some((turn) => turn.id === this.activeTurnId)) {
      this.activeTurnId = undefined
    }
    this.emit('structure')
  }

  /** 已挂载（元素在文档中）的首个 turn */
  firstMountedTurn(): ConversationTurn | undefined {
    return this.turns.find((turn) => (turn.user?.element ?? turn.assistant?.element)?.isConnected)
  }

  /** 内部使用：由 Indexer 在扫描后提交本轮结果并广播 */
  commit(kind: ChangeKind): void {
    if (kind === 'none') return
    // 只有影响 user prompt 语义的事件推进修订号（assistant 流式 / 纯元素绑定不推进）
    if (kind === 'structure' || kind === 'user-text') this.semanticRevision++
    this.emit(kind)
  }
}

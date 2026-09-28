import type { ChatProvider, LocatedMessage, LocatedTurn } from '../providers/types'
import { collapseWhitespace, stripMarkdownDecorations, truncateUnicode } from '../utils/dom.ts'
import { reportError } from '../utils/logger.ts'
import { perf } from '../utils/performance.ts'
import { buildFallbackKey } from './stableId.ts'
import { ConversationStore } from './store.ts'
import type { ChangeKind, ConversationMessage, ConversationTurn, DetachedTurn } from './types'

/** 一条待入库记录：key 为稳定 ID；opensTurn 描述 turn 边界 */
interface IncomingRecord {
  record: LocatedMessage
  key: string
  /** 'user' 开启新 turn；'assistant' 无 user 时开启 assistant-only turn；'attach' 归入当前 turn */
  opensTurn: 'user' | 'assistant' | 'attach'
  turnRoot: HTMLElement | null
}

interface DraftTurn {
  id: string
  root?: HTMLElement
  user?: ConversationMessage
  assistant?: ConversationMessage
}

function buildTitle(text: string): string {
  const cleaned = stripMarkdownDecorations(collapseWhitespace(text))
  if (!cleaned) return '（图片 / 附件）'
  return truncateUnicode(cleaned, 60)
}

function buildPreview(text: string): string {
  return truncateUnicode(collapseWhitespace(text), 160)
}

function byCapturedAt(a: DetachedTurn, b: DetachedTurn): number {
  return a.capturedAt - b.capturedAt
}

/**
 * 扫描 DOM → 稳定 ID → 去重 → 构建/调和 turn 列表。
 * 主路径消费 Provider 的 Turn-first 结果（每个 [data-turn-key] 天然一个 turn），
 * legacy DOM 走消息流式分组。未挂载但已收获的 turn 通过 anchor 机制保序保留。
 */
export class ConversationIndexer {
  private provider: ChatProvider
  private store: ConversationStore
  private scanning = false
  private emptyScanCount = 0

  // 显式字段赋值（不用参数属性）：Node 测试运行器的类型剥离不支持该语法
  constructor(provider: ChatProvider, store: ConversationStore) {
    this.provider = provider
    this.store = store
  }

  /** Full scan（correctness 基准路径）：全量定位 + 全量解析 + 完整调和 */
  scan(force = false, isFallback = false): void {
    if (this.scanning) return
    this.scanning = true
    const startedAt = performance.now()
    try {
      const incoming = this.collectIncoming()
      if (incoming.length > 0) {
        perf.markFirstLiveScan()
        perf.markFirstLiveReconcile()
      }
      this.reconcile(incoming, force)
    } catch (err) {
      reportError('indexer.scan', err)
    } finally {
      this.scanning = false
      perf.fullScan(performance.now() - startedAt, isFallback)
    }
  }

  /**
   * 增量扫描（fast path）：只解析 dirty / 未知 / 重挂载的 turn，
   * 已知且元素仍连接的 turn 零查询跳过。与 full scan 共用同一套调和核心，
   * 顺序 / 卸载 / detached 锚点语义完全一致。
   * 任何无法安全增量处理的情况（legacy DOM、解析失败、assistant 首次出现）
   * 一律回退 full scan —— correctness first，宁可多一次 2ms 扫描，不漏一个问题。
   */
  scanDirty(dirtyRoots: Iterable<HTMLElement>): void {
    if (this.scanning) return
    this.scanning = true
    const startedAt = performance.now()
    let applied = false
    let parsedCount = 0
    let skippedCount = 0
    try {
      const result = this.scanDirtyInner(dirtyRoots)
      applied = result.applied
      parsedCount = result.parsed
      skippedCount = result.skipped
    } catch (err) {
      reportError('indexer.scanDirty', err)
      applied = false
    } finally {
      this.scanning = false
    }
    if (applied) {
      perf.incrementalScan(performance.now() - startedAt, parsedCount, skippedCount)
    } else {
      // 回退 full scan（fallback 计数在 scan 内记录）
      this.scan(true, true)
    }
  }

  /** 返回 applied=false 表示需要回退 full scan */
  private scanDirtyInner(
    dirtyRoots: Iterable<HTMLElement>
  ): { applied: boolean; parsed: number; skipped: number } {
    const located = this.provider.locateTurnRoots()
    // legacy DOM（无原生 data-turn-key）无法可靠增量 → full scan
    if (located.some((entry) => entry.id === null)) return { applied: false, parsed: 0, skipped: 0 }

    const dirtySet = new Set(dirtyRoots)
    const turnByRoot = new Map<HTMLElement, ConversationTurn>()
    const turnById = new Map<string, ConversationTurn>()
    for (const turn of this.store.turns) {
      if (turn.root) turnByRoot.set(turn.root, turn)
      turnById.set(turn.id, turn)
    }

    const ordinalCounter = new Map<string, number>()
    const incoming: IncomingRecord[] = []
    let parsed = 0
    let skipped = 0

    for (const entry of located) {
      const known = turnByRoot.get(entry.root) ?? turnById.get(entry.id!)
      if (known && !dirtySet.has(entry.root)) {
        const userConnected = known.user?.element?.isConnected ?? false
        const assistantOk = !known.assistant || known.assistant.element?.isConnected || false
        if (userConnected && assistantOk) {
          // 纯跳过：零查询，直接引用 Store 现有绑定（root 引用刷新为当前 DOM）
          if (known.user && known.user.element) {
            incoming.push({
              record: {
                role: 'user',
                text: known.user.text,
                element: known.user.element,
                turnContainer: entry.root,
                externalId: known.user.id
              },
              key: known.user.id,
              opensTurn: 'user',
              turnRoot: entry.root
            })
          }
          if (known.assistant?.element?.isConnected) {
            incoming.push({
              record: {
                role: 'assistant',
                text: known.assistant.text,
                element: known.assistant.element,
                turnContainer: entry.root,
                externalId: known.assistant.id
              },
              key: known.assistant.id,
              opensTurn: 'attach',
              turnRoot: entry.root
            })
          }
          skipped++
          continue
        }
        // 重挂载 / 元素被替换：轻量解析（只绑元素 / 读 ID，不提取文本）
        const light = this.provider.parseTurn(entry.root, { includeText: false })
        if (!light) return { applied: false, parsed, skipped }
        if (!light.user !== !known.user) return { applied: false, parsed, skipped }
        if (light.assistant && !known.assistant) return { applied: false, parsed, skipped }
        if (light.user && known.user) {
          incoming.push({
            record: { ...light.user, text: known.user.text, externalId: known.user.id },
            key: known.user.id,
            opensTurn: 'user',
            turnRoot: entry.root
          })
        }
        if (light.assistant && known.assistant) {
          incoming.push({
            record: { ...light.assistant, text: known.assistant.text, externalId: known.assistant.id },
            key: known.assistant.id,
            opensTurn: 'attach',
            turnRoot: entry.root
          })
        }
        skipped++
        continue
      }
      // 新 turn 或 dirty turn：完整解析（含文本提取）
      const parsedTurn = this.provider.parseTurn(entry.root, { includeText: true })
      if (!parsedTurn) return { applied: false, parsed, skipped }
      parsed++
      incoming.push(...this.buildRecords([parsedTurn], ordinalCounter))
    }

    this.reconcile(incoming, false)
    return { applied: true, parsed, skipped }
  }

  /** LocatedTurn → 入库记录（full 与 incremental 共用；ordinalCounter 跨同批共享） */
  private buildRecords(turns: LocatedTurn[], ordinalCounter: Map<string, number>): IncomingRecord[] {
    const incoming: IncomingRecord[] = []
    for (const turn of turns) {
      if (turn.user) {
        incoming.push({
          record: turn.user,
          key: this.stableKey(turn.user, ordinalCounter),
          opensTurn: 'user',
          turnRoot: turn.root
        })
      }
      if (turn.assistant) {
        incoming.push({
          record: turn.assistant,
          key: this.stableKey(turn.assistant, ordinalCounter),
          opensTurn: turn.user ? 'attach' : 'assistant',
          turnRoot: turn.root
        })
      }
    }
    return incoming
  }

  /** 稳定 key：externalId 优先；缺失时 role + 归一化文本哈希 + 同内容序号 */
  private stableKey(record: LocatedMessage, ordinalCounter: Map<string, number>): string {
    if (record.externalId) return record.externalId
    const normalized = collapseWhitespace(record.text)
    const dupKey = record.role + '\u0000' + normalized
    const ordinal = ordinalCounter.get(dupKey) ?? 0
    ordinalCounter.set(dupKey, ordinal + 1)
    return buildFallbackKey(record.role, normalized, ordinal)
  }

  findMountedTurn(turnId: string): ConversationTurn | undefined {
    const turn = this.store.getTurn(turnId)
    if (!turn) return undefined
    const element = turn.user?.element ?? turn.assistant?.element
    return element?.isConnected ? turn : undefined
  }

  /** Turn-first 优先；legacy DOM 回退消息流式定位 */
  private collectIncoming(): IncomingRecord[] {
    const ordinalCounter = new Map<string, number>()
    const turns = this.provider.locateTurns()
    if (turns.length > 0) return this.buildRecords(turns, ordinalCounter)

    const located = this.provider.locateMessages()
    return located.map((record) => ({
      record,
      key: this.stableKey(record, ordinalCounter),
      opensTurn: record.role === 'user' ? ('user' as const) : ('attach' as const),
      turnRoot: record.turnContainer
    }))
  }


  /** 调和核心：full 与 incremental 共用（空扫描保护 / 快路径 / 全量调和） */
  private reconcile(incoming: IncomingRecord[], force: boolean): void {
    const store = this.store

    if (incoming.length === 0) {
      this.emptyScanCount++
      // 短暂空窗（React 重挂载等）：先只标记卸载保留 metadata；持续为空才视为真正清空
      if (store.visibleOrder.length > 0) {
        for (const id of store.visibleOrder) {
          const msg = store.messages.get(id)
          if (msg && msg.isMounted) {
            msg.isMounted = false
            msg.element = undefined
          }
        }
        store.visibleOrder = []
        store.lastVisibleKeys = []
        store.commit('elements')
      }
      if (
        this.emptyScanCount >= 2 &&
        (store.turns.length > 0 || store.detached.length > 0) &&
        // 导航缓存恢复的 turn 在 ChatGPT 历史尚未挂载时必须存活，
        // 只在缓存确认 stale（bootstrap 层判定）后恢复正常清空行为
        !store.cacheHydrated
      ) {
        store.turns = []
        store.detached = []
        store.commit('structure')
      }
      return
    }
    this.emptyScanCount = 0

    const keys = incoming.map((item) => item.key)

    // ---- 快路径：key 序列未变且元素全部仍连接 → 仅同步文本（流式输出走这里，不触发重建）----
    if (
      !force &&
      keys.length === store.lastVisibleKeys.length &&
      keys.every((key, i) => key === store.lastVisibleKeys[i])
    ) {
      let textChanged = false
      let allConnected = true
      for (let i = 0; i < incoming.length; i++) {
        const msg = store.messages.get(keys[i]!)
        if (!msg || !msg.element?.isConnected) {
          allConnected = false
          break
        }
        const text = incoming[i]!.record.text
        if (msg.text !== text) {
          msg.text = text
          textChanged = true
        }
      }
      if (allConnected) {
        store.commit(textChanged ? 'text' : 'none')
        return
      }
    }

    // ---- 全量调和 ----
    const visibleIds: string[] = []
    let elementChanged = false
    for (const { record, key } of incoming) {
      const existing = store.messages.get(key)
      if (existing) {
        if (existing.element !== record.element) {
          existing.element = record.element
          elementChanged = true
        }
        if (existing.text !== record.text) existing.text = record.text
        existing.role = record.role
        existing.isMounted = true
      } else {
        store.messages.set(key, {
          id: key,
          role: record.role,
          text: record.text,
          turnIndex: -1,
          element: record.element,
          firstSeenAt: Date.now(),
          isMounted: true
        })
        elementChanged = true
      }
      visibleIds.push(key)
    }

    const visibleIdSet = new Set(visibleIds)

    // 标记本轮新卸载的消息（metadata 保留，释放 DOM 引用）
    let unmountedCount = 0
    for (const id of store.visibleOrder) {
      if (visibleIdSet.has(id)) continue
      const msg = store.messages.get(id)
      if (msg && msg.isMounted) {
        msg.isMounted = false
        msg.element = undefined
        unmountedCount++
        elementChanged = true
      }
    }

    // 组装当前可见 turn（Turn-first：由 provider 的 turn 边界直接决定分组）
    const drafts: DraftTurn[] = []
    let current: DraftTurn | null = null
    for (const item of incoming) {
      const msg = store.messages.get(item.key)!
      if (item.opensTurn === 'user') {
        current = { id: msg.id, root: item.turnRoot ?? undefined, user: msg }
        drafts.push(current)
      } else if (item.opensTurn === 'assistant' || !current) {
        current = { id: msg.id, root: item.turnRoot ?? undefined, assistant: msg }
        drafts.push(current)
      } else {
        current.assistant = msg
      }
    }
    const visibleTurnIds = new Set(drafts.map((draft) => draft.id))

    const prevTurns = store.turns

    // 疑似分支切换 / 大面积重挂载：可见集合中同时出现"大量卸载 + 大量全新 id"
    // （内容被整体替换）时丢弃旧 detached。纯虚拟化滚动卸载不产生新 id，不会误触发，
    // 保证"当前可见 branch 是真实索引"，不猜测不可见分支。
    const prevIdSet = new Set(prevTurns.map((turn) => turn.id))
    const newIdCount = drafts.filter((draft) => !prevIdSet.has(draft.id)).length
    const replaceThreshold = Math.max(8, Math.ceil(visibleIds.length * 0.8))
    if (unmountedCount >= replaceThreshold && newIdCount >= replaceThreshold) {
      store.detached = []
    }

    // 清理已有 detached：重新挂载的移除，锚点丢失的重新锚定
    const keptDetached: DetachedTurn[] = []
    const detachedIds = new Set<string>()
    for (const entry of store.detached) {
      if (visibleTurnIds.has(entry.turn.id)) continue
      const reanchored = this.reanchor(entry, prevTurns, visibleTurnIds)
      if (reanchored) {
        keptDetached.push(reanchored)
        detachedIds.add(reanchored.turn.id)
      }
    }

    // 本轮新卸载的 user turn → 进入 detached，锚定到可见邻居
    const now = Date.now()
    for (let i = 0; i < prevTurns.length; i++) {
      const prevTurn = prevTurns[i]!
      if (!prevTurn.user) continue
      if (visibleTurnIds.has(prevTurn.id) || detachedIds.has(prevTurn.id)) continue
      const msg = store.messages.get(prevTurn.id)
      if (!msg || msg.isMounted) continue
      const anchors = this.computeAnchors(i, prevTurns, visibleTurnIds)
      if (anchors.beforeId === undefined && anchors.afterId === undefined) continue
      keptDetached.push({ turn: prevTurn, capturedAt: now, ...anchors })
      detachedIds.add(prevTurn.id)
    }

    // 合并：before 锚点插到目标 turn 之前，after 锚点插到其后
    const beforeMap = new Map<string, DetachedTurn[]>()
    const afterMap = new Map<string, DetachedTurn[]>()
    for (const entry of keptDetached) {
      if (entry.beforeId && visibleTurnIds.has(entry.beforeId)) {
        pushInto(beforeMap, entry.beforeId, entry)
      } else if (entry.afterId && visibleTurnIds.has(entry.afterId)) {
        pushInto(afterMap, entry.afterId, entry)
      }
    }

    const finalTurns: ConversationTurn[] = []
    for (const draft of drafts) {
      const before = beforeMap.get(draft.id)
      if (before) {
        before.sort(byCapturedAt)
        for (const entry of before) finalTurns.push(entry.turn)
      }
      finalTurns.push(this.materializeTurn(draft))
      const after = afterMap.get(draft.id)
      if (after) {
        after.sort(byCapturedAt)
        for (const entry of after) finalTurns.push(entry.turn)
      }
    }

    finalTurns.forEach((turn, index) => {
      turn.index = index
      if (turn.user) turn.user.turnIndex = index
      else if (turn.assistant) turn.assistant.turnIndex = index
    })

    store.detached = keptDetached
    store.turns = finalTurns
    store.visibleOrder = visibleIds
    store.lastVisibleKeys = keys
    if (store.activeTurnId && !finalTurns.some((turn) => turn.id === store.activeTurnId)) {
      store.activeTurnId = undefined
    }

    const idsChanged =
      finalTurns.length !== prevTurns.length || finalTurns.some((turn, i) => turn.id !== prevTurns[i]?.id)
    const kind: ChangeKind = idsChanged ? 'structure' : elementChanged ? 'elements' : 'text'
    store.commit(kind)
  }

  private materializeTurn(draft: DraftTurn): ConversationTurn {
    const sourceText = draft.user?.text ?? draft.assistant?.text ?? ''
    return {
      id: draft.id,
      index: -1,
      root: draft.root,
      user: draft.user,
      assistant: draft.assistant,
      title: buildTitle(sourceText),
      preview: buildPreview(sourceText)
    }
  }

  private reanchor(
    entry: DetachedTurn,
    prevTurns: ConversationTurn[],
    visibleTurnIds: Set<string>
  ): DetachedTurn | null {
    const anchorValid =
      (entry.beforeId !== undefined && visibleTurnIds.has(entry.beforeId)) ||
      (entry.afterId !== undefined && visibleTurnIds.has(entry.afterId))
    if (anchorValid) return entry
    const index = prevTurns.findIndex((turn) => turn.id === entry.turn.id)
    if (index === -1) return null
    const anchors = this.computeAnchors(index, prevTurns, visibleTurnIds)
    if (anchors.beforeId === undefined && anchors.afterId === undefined) return null
    return { ...entry, ...anchors }
  }

  private computeAnchors(
    index: number,
    prevTurns: ConversationTurn[],
    visibleTurnIds: Set<string>
  ): { beforeId?: string; afterId?: string } {
    for (let j = index + 1; j < prevTurns.length; j++) {
      const id = prevTurns[j]!.id
      if (visibleTurnIds.has(id)) return { beforeId: id }
    }
    for (let j = index - 1; j >= 0; j--) {
      const id = prevTurns[j]!.id
      if (visibleTurnIds.has(id)) return { afterId: id }
    }
    return {}
  }
}

function pushInto(map: Map<string, DetachedTurn[]>, key: string, entry: DetachedTurn): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(entry)
  else map.set(key, [entry])
}

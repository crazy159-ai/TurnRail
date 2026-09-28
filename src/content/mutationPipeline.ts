import { perf } from '../utils/performance.ts'

/**
 * Mutation 分类器 + Dirty Turn 队列（v1.2 增量索引的入口）。
 *
 * 设计原则（规格 #13-25、#82、#95）：
 * - 分类只用 data-* 语义属性，不用 CSS class；
 * - assistant streaming（位于已挂载 assistant unit 内部的变化）不进入索引，
 *   只调度一次去抖的 geometry refresh；
 * - assistant unit 首次挂载 / turn 结构变化绝不误忽略；
 * - 无法安全判定的一律回退 full scan（correctness first）。
 */

export type MutationClass = 'new-turn' | 'turn-structure' | 'assistant-stream' | 'irrelevant' | 'unknown'

export interface MutationContext {
  /** turn 容器选择器（[data-turn-key]） */
  turnSelector: string
  /** assistant unit 选择器（[data-chatgpt-search-unit-key$=":assistant"] 及 fallback） */
  assistantUnitSelectors: readonly string[]
  /**
   * target 是否位于"Store 中已挂载的 assistant unit"内部。
   * 由 bootstrap 注入（查 Store 元素绑定），保证 streaming 过滤不会误伤首次挂载。
   */
  isMountedAssistantTarget(target: Element): boolean
}

export interface MutationBatch {
  dirtyTurns: Set<HTMLElement>
  needsFullScan: boolean
  assistantStreamOnly: boolean
  relevantCount: number
  ignoredCount: number
}

function isElementLike(node: unknown): node is Element {
  return !!node && typeof (node as Element).closest === 'function'
}

/** record.target 可能是文本节点：向上取最近的元素 */
function targetElement(record: MutationRecord): Element | null {
  const target = record.target as Node | null
  if (!target) return null
  if (isElementLike(target)) return target
  const parent = target.parentElement
  return isElementLike(parent) ? parent : null
}

function collectTurnRoots(element: Element, turnSelector: string, into: Set<HTMLElement>): boolean {
  let found = false
  if (typeof element.matches === 'function' && element.matches(turnSelector)) {
    into.add(element as HTMLElement)
    found = true
  }
  if (typeof element.querySelectorAll === 'function') {
    element.querySelectorAll<HTMLElement>(turnSelector).forEach((turn) => {
      into.add(turn)
      found = true
    })
  }
  return found
}

/**
 * 纯函数：把一批 MutationRecord 分类为
 * - dirtyTurns：需要增量解析的 turn root（去重）
 * - needsFullScan：无法安全增量处理（unknown）
 * - assistantStreamOnly：本批全部为 streaming 更新（只需 geometry refresh）
 */
export function classifyMutations(records: readonly MutationRecord[], ctx: MutationContext): MutationBatch {
  const dirtyTurns = new Set<HTMLElement>()
  let newTurn = 0
  let turnStructure = 0
  let assistantStream = 0
  let irrelevant = 0
  let unknown = 0

  for (const record of records) {
    // 1) added/removed 子树中含 turn root：新 turn / 挂载 / 卸载 / 结构替换
    let structural = false
    for (const nodeList of [record.addedNodes, record.removedNodes]) {
      for (const node of nodeList) {
        if (isElementLike(node) && collectTurnRoots(node, ctx.turnSelector, dirtyTurns)) {
          structural = true
        }
      }
    }
    if (structural) {
      turnStructure++
      if (record.addedNodes.length > 0) newTurn++
      continue
    }

    const target = targetElement(record)
    if (!target) {
      // 无法定位（detached 文本节点等）→ 保守 full scan，绝不静默忽略
      unknown++
      continue
    }

    // 2) assistant streaming：位于已挂载 assistant unit 内部的后续更新 → 忽略索引
    if (ctx.isMountedAssistantTarget(target)) {
      assistantStream++
      continue
    }

    // 3) turn 内其他变化（user 重渲染 / 附件 / regenerate 控件等）→ 该 turn dirty
    const turnRoot = target.closest<HTMLElement>(ctx.turnSelector)
    if (turnRoot) {
      dirtyTurns.add(turnRoot)
      turnStructure++
      continue
    }

    // 4) conversation root 级、非 turn 的变化（横幅 / 按钮等）→ 与导航无关
    irrelevant++
  }

  const relevant = turnStructure + unknown
  const ignored = assistantStream + irrelevant
  perf.classify('newTurn', newTurn)
  perf.classify('turnStructure', turnStructure - newTurn)
  perf.classify('assistantStream', assistantStream)
  perf.classify('irrelevant', irrelevant)
  perf.classify('unknown', unknown)

  return {
    dirtyTurns,
    needsFullScan: unknown > 0,
    assistantStreamOnly: assistantStream > 0 && turnStructure === 0 && unknown === 0,
    relevantCount: relevant,
    ignoredCount: ignored
  }
}

export interface MutationPipelineHandlers {
  /** 去重后的 dirty turn roots（批量，30~80ms 窗口合并） */
  onDirty(roots: Set<HTMLElement>): void
  /** 存在无法增量处理的变化 → full scan */
  onFullScan(): void
  /** 本批只有 streaming 更新 → 去抖 geometry refresh */
  onAssistantStream(): void
}

export interface MutationPipeline {
  handle(records: readonly MutationRecord[]): void
  /** 立即结算（测试 / 路由切换前用） */
  flushNow(): void
  destroy(): void
}

/**
 * 批处理管道：同一帧的多个 record 合并为一次 flush；
 * Set 去重保证同一 turn 的 N 次 streaming mutation 只解析一次（规格 #20/#60）。
 */
export function createMutationPipeline(
  ctx: MutationContext,
  handlers: MutationPipelineHandlers,
  debounceMs = 40
): MutationPipeline {
  let dirtyTurns: Set<HTMLElement> = new Set()
  let fullScanRequested = false
  let assistantStreamPending = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    timer = undefined
    if (fullScanRequested) {
      fullScanRequested = false
      dirtyTurns = new Set()
      assistantStreamPending = false
      handlers.onFullScan()
      return
    }
    if (dirtyTurns.size > 0) {
      const roots = dirtyTurns
      dirtyTurns = new Set()
      handlers.onDirty(roots)
    }
    if (assistantStreamPending) {
      assistantStreamPending = false
      handlers.onAssistantStream()
    }
  }

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(flush, debounceMs)
  }

  return {
    handle(records): void {
      const batch = classifyMutations(records, ctx)
      perf.observerCallback(records.length, batch.relevantCount, batch.ignoredCount)
      if (batch.needsFullScan) fullScanRequested = true
      for (const turn of batch.dirtyTurns) dirtyTurns.add(turn)
      if (batch.assistantStreamOnly) assistantStreamPending = true
      if (fullScanRequested || dirtyTurns.size > 0 || assistantStreamPending) schedule()
    },
    flushNow(): void {
      if (timer !== undefined) {
        clearTimeout(timer)
        flush()
      }
    },
    destroy(): void {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      dirtyTurns = new Set()
      fullScanRequested = false
      assistantStreamPending = false
    }
  }
}

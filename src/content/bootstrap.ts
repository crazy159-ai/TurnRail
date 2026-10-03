import { ChatGptProvider } from '../providers/chatgpt'
import { ConversationStore } from '../conversation/store'
import { ConversationIndexer } from '../conversation/indexer'
import { captureFullHistory, isCaptureRunning } from '../conversation/historyCapture'
import {
  computeHistoryCoverage,
  historyCoverageLabel
} from '../conversation/historyCoverage'
import { createPassiveTopWatch } from './passiveTopWatch'
import { ScrollSpy } from '../navigation/scrollSpy'
import { jumpToTurn } from '../navigation/jump'
import { isRecoverRunning, recoverAndJump, getRecoverLog } from '../navigation/recoverTarget'
import { createNavigationUi } from '../ui/createShadowRoot'
import { watchConversationRoot, observeConversationTurns } from './observers'
import { createRouteWatcher, type RouteChange, type RouteChangeSource } from './routeWatcher'
import { readRouteIdentity, routeIdentityKey } from './routeIdentity'
import {
  beginConversationTransition,
  createAcceptedDomState,
  readConversationDomSignature,
  isConversationDomReady,
  isSameDomSignature,
  type AcceptedDomState,
  type ConversationDomSignature,
  type ConversationTransitionGate,
  type TransitionGateStats
} from './conversationTransition'
import { createMutationPipeline } from './mutationPipeline'
import { startStartupScan } from './startupScan'
import { perf } from '../utils/performance'
import { buildDiagnostics } from '../utils/diagnostics'
import { isAtVisualBottom, isAtVisualTop, getScrollBounds } from '../navigation/scrollGeometry'
import { DEBUG, debugLog, debugWarn, reportError } from '../utils/logger'
import { debounce } from '../utils/debounce'
import { ConversationCacheStore } from '../cache/cacheStore'
import { CheckpointStore } from '../handoff/checkpointStore'
import { PendingHandoffStore } from '../handoff/pendingStore'
import { injectPendingHandoff } from '../handoff/injector'
import { buildConversationHandoff } from '../handoff/builder'
import { formatConversationHandoff } from '../handoff/formatter'
import type { HandoffTurnSnapshot } from '../handoff/types'
import type { ConversationContinuationCapability } from '../providers/types'
import { serializeConversation } from '../cache/serializer'
import { hydrateCachedConversation } from '../cache/hydrator'
import { isLikelyStale } from '../cache/reconciler'

/**
 * bootstrap() 在同一 content world 内的执行次数（纯数字诊断，v1.2.3）。
 * 正常恒为 1；>1 说明同一页面重复初始化（排查"重复 warning"类问题用）。
 * 只在 DEBUG 下经 __tnDebug.bootstrapCount 暴露，不含任何会话内容。
 */
let bootstrapInstanceCount = 0

/**
 * 组装全部模块并管理生命周期：
 * 路由变化 → 停止 spy / flush 待写缓存 / 重置 store → 并行读取导航缓存（cache-first）
 * → Live DOM 扫描 → 调和 → 观察器继续增量更新。
 *
 * 缓存原则：Cache 是加速层，不是事实来源 —— 缓存负责先显示，Live ChatGPT DOM 负责
 * 最终正确性（Live 永远胜出）。缓存读取 / 写入全链路容错，任何缓存失败都退化为
 * 原有 Live-only 行为，绝不影响 TurnRail 正常启动。
 */
export function bootstrap(): void {
  bootstrapInstanceCount++
  perf.reset()
  const provider = new ChatGptProvider()
  const store = new ConversationStore()
  const indexer = new ConversationIndexer(provider, store)
  const cacheStore = new ConversationCacheStore()
  const checkpointStore = new CheckpointStore()
  const pendingHandoffStore = new PendingHandoffStore()

  const ui = createNavigationUi(provider, {
    onJump: (turnId) => void handleJump(turnId),
    onLoadHistory: () => void handleLoadHistory(),
    onToggleCache: () => void handleToggleCache(),
    onToggleCheckpoint: (turnId) => handleToggleCheckpoint(turnId),
    isCheckpointed: (turnId) => isTurnCheckpointed(turnId),
    onOpenHandoff: () => handleOpenHandoff(),
    onHandoffCopy: (text) => void handleHandoffCopy(text),
    onHandoffContinue: (text) => void handleHandoffContinue(text),
    onHandoffCancel: () => handleHandoffCancel()
  })
  document.body.appendChild(ui.host)
  ui.setCacheEnabled(cacheStore.isAvailable())

  const spy = new ScrollSpy(store, provider, (turnId) => {
    store.activeTurnId = turnId
    ui.setActive(turnId)
  })

  // ---------- 被动历史收获（Passive History Harvest） ----------
  // TurnRail 绝不为补全历史主动滚动当前聊天（BACKGROUND_TASK_MUST_NOT_SCROLL）：
  // 用户自然浏览挂载的内容由 Observer 管道自动收获；reachedTop 只收集
  // "用户自然到顶且懒加载稳定"的被动证据，或来自显式捕获 / 缓存 complete。
  /**
   * 路由代数（conversation generation，规格 #25）：每次路由身份变化递增。
   * 所有 async path（cache read / transition / startup scan / 显式捕获 /
   * 恢复跳转 / handoff 注入 / 延时回调）都必须捕获并复核 —— 不一致即丢弃，
   * 形成"A 的 async work 绝不写进 B"的硬不变量（规格 #26）。
   */
  let conversationGeneration = 0
  /**
   * 本轮路由是否已确认到达视觉顶部（无更多旧历史）。依据仅三种：
   * 用户显式「加载全部历史」确认到顶 / 缓存 complete / 被动到顶证据。
   * 只影响 coverage 展示语义（state=complete），绝不触发任何滚动。
   */
  let reachedTop = false

  function refreshHistoryCoverageUi(): void {
    ui.setHistoryStatus(historyCoverageLabel(computeHistoryCoverage(store, reachedTop)))
  }

  const topWatch = createPassiveTopWatch({
    getContainer: () => provider.getScrollContainer(),
    getTurnCount: () => store.turns.length,
    onTopConfirmed: () => {
      reachedTop = true
      refreshHistoryCoverageUi()
    }
  })

  // ---------- 导航缓存桥接（cache-first + live reconcile） ----------
  // generation：每次路由变化递增；异步缓存读取返回时 generation 已变则直接丢弃
  //（防 A/B 会话竞态串写 —— A 的缓存绝不进入 B 的 Store）。声明见 warmup 段。
  /** 当前路由对应的已缓存会话 id（null = 未缓存 / 未知） */
  let activeCachedId: string | null = null
  /** 已缓存会话的 createdAt（重写缓存时保留创建时间语义） */
  let activeCreatedAt: number | undefined = undefined
  /** 本次会话自缓存 hydrate 的 turn id（stale 判定依据；null = 缓存未参与） */
  let hydratedTurnIds: Set<string> | null = null
  /** hydrate 过程中抑制自动保存调度（刚恢复的缓存原样写回没有意义） */
  let hydrating = false
  let lastHydrateMs: number | null = null
  let lastReconcileMs: number | null = null
  /** 待落盘的缓存快照描述（debounce 到期或路由离开时写入） */
  let pendingSave: { conversationId: string; complete: boolean } | null = null

  /**
   * CacheStore 可用性 → UI 缓存控件单向同步（v1.2.2）。
   * 只切换 disabled，不动 ☆/★：已成功 hydrate 的 ★ 不因 context 失效被抹掉
   * （真实缓存数据仍在 chrome.storage 里，刷新页面即可恢复访问）。
   */
  function syncCacheAvailability(): boolean {
    const available = cacheStore.isAvailable()
    ui.setCacheEnabled(available)
    return available
  }

  /** 缓存不可用时的提示文案（只在用户主动操作缓存按钮时显示；被动读写不弹） */
  function cacheUnavailableMessage(): string {
    switch (cacheStore.getUnavailableReason()) {
      case 'extension-context-invalidated':
        return '扩展已重新加载，请刷新 ChatGPT 页面后恢复缓存功能'
      case 'storage-error':
        return '缓存暂不可用，导航功能不受影响'
      default:
        return '缓存不可用，导航功能不受影响'
    }
  }

  const scheduleAutoSave = debounce(() => {
    const pending = pendingSave
    pendingSave = null
    if (pending) void writeCacheSnapshot(pending.conversationId, pending.complete)
  }, 1200)

  // ---------- Checkpoint（Handoff 必带轮次的用户标记） ----------
  // 只操作内存元数据（CheckpointStore 按会话分桶），随后按需重建目录；
  // 不写 storage、不进入 observer hot path（用户事件驱动，规格 #38）。

  /** 检查点 key 与缓存一致：使用 provider 会话 id（无 id 的本地会话不参与 Handoff） */
  function currentCheckpointConversationId(): string | null {
    return provider.getConversationId()
  }

  function isTurnCheckpointed(turnId: string): boolean {
    const conversationId = currentCheckpointConversationId()
    return conversationId !== null && checkpointStore.isCheckpointed(conversationId, turnId)
  }

  function handleToggleCheckpoint(turnId: string): void {
    const conversationId = currentCheckpointConversationId()
    const turn = store.getTurn(turnId)
    if (!conversationId || !turn) return
    checkpointStore.toggle(conversationId, { id: turn.id, index: turn.index })
    syncHandoffEntry()
    ui.refreshList()
  }

  /** 面板头 Handoff 入口：当前会话存在 checkpoint 标记时可见（路由重置后同步） */
  function syncHandoffEntry(): void {
    const conversationId = currentCheckpointConversationId()
    ui.setHandoffEntryVisible(conversationId !== null && checkpointStore.count(conversationId) > 0)
  }

  // ---------- Handoff（确定性结构化交接：Preview → 用户审核 → 复制/继续） ----------
  // 只在用户点击 CTA 时执行（用户事件驱动，绝不进入 observer hot path）。
  // Snapshot 在点击时刻同步复制正文 —— 之后 DOM/store 再变不影响预览内容。

  function snapshotTurnsForHandoff(): HandoffTurnSnapshot[] {
    return store.turns.map((turn) => ({
      id: turn.id,
      index: turn.index,
      userText: turn.user?.text ?? '',
      assistantText: turn.assistant?.text ?? null,
      userCompleteness: turn.user?.contentCompleteness,
      assistantCompleteness: turn.assistant?.contentCompleteness
    }))
  }

  function handleOpenHandoff(): void {
    try {
      const conversationId = currentCheckpointConversationId()
      const health = ui.getHealthSnapshot()
      const handoff = buildConversationHandoff({
        conversationId,
        turns: snapshotTurnsForHandoff(),
        checkpoints: conversationId ? checkpointStore.list(conversationId) : [],
        health: health
          ? { score: health.score, level: health.level, confidence: health.confidence }
          : undefined
      })
      ui.showHandoffPreview({
        text: formatConversationHandoff(handoff),
        warnings: handoff.warnings
      })
    } catch (err) {
      reportError('handoff.build', err)
      ui.setStatus('生成交接上下文失败，请重试')
      window.setTimeout(() => ui.setStatus(''), 3500)
    }
  }

  /**
   * 剪贴板写入的"复制行为"与"UI 提示"分离：返回真实结果，
   * 由调用方按成败渲染状态 —— 失败绝不显示"已复制"（no fake success）。
   */
  async function tryCopyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  async function handleHandoffCopy(text: string): Promise<void> {
    const copied = await tryCopyText(text)
    ui.setStatus(
      copied
        ? '交接上下文已复制，可粘贴到新聊天'
        : '复制失败，请在预览框中手动全选复制'
    )
    window.setTimeout(() => ui.setStatus(''), 3500)
  }

  function handleHandoffCancel(): void {
    ui.hideHandoffPreview()
  }

  // ---------- PendingHandoff：跨标签页注入（只填草稿，绝不自动发送） ----------

  /** DEBUG 诊断元数据（纯数字，绝不含 payload；保存/注入后更新） */
  let handoffPendingMeta: { pending: boolean; ageMs: number | null; characters: number | null } = {
    pending: false,
    ageMs: null,
    characters: null
  }

  /** Provider 的会话延续能力（capability 探测，未实现返回 null） */
  function getContinuationCapability(): ConversationContinuationCapability | null {
    const candidate = provider as unknown as Partial<ConversationContinuationCapability>
    if (
      typeof candidate.getComposer === 'function' &&
      typeof candidate.setComposerText === 'function' &&
      typeof candidate.reserveNewConversation === 'function'
    ) {
      return candidate as ConversationContinuationCapability
    }
    return null
  }

  /** 回退提示：按剪贴板真实结果给用户可恢复路径（storage / 弹窗失败共用） */
  async function fallbackToClipboard(text: string): Promise<void> {
    const copied = await tryCopyText(text)
    ui.setStatus(
      copied
        ? '无法自动传递到新标签页，已复制 Handoff，请手动打开新聊天并粘贴'
        : '无法自动传递，也未能写入剪贴板，请在预览框中手动全选复制'
    )
    window.setTimeout(() => ui.setStatus(''), 4500)
  }

  async function handleHandoffContinue(text: string): Promise<void> {
    if (text.length === 0) return
    const capability = getContinuationCapability()

    // 同步链路第一步：预留新标签页。window.open 必须仍在用户点击手势内执行，
    // 否则 await storage 之后弹窗会被浏览器拦截（popup blocked 假成功的根源）。
    // 预留失败 = 弹窗被阻止：绝不显示"已打开"，pending 也不创建（正文走预览/剪贴板）。
    const reservation = capability ? capability.reserveNewConversation() : null
    if (!reservation) {
      if (!capability) {
        await fallbackToClipboard(text)
        return
      }
      const copied = await tryCopyText(text)
      ui.setStatus(
        copied
          ? '浏览器阻止了新标签页，Handoff 已复制，请手动打开新聊天并粘贴'
          : '浏览器阻止了新标签页，也无法自动复制，请在预览框中手动全选复制'
      )
      window.setTimeout(() => ui.setStatus(''), 4500)
      return
    }

    // 预留成功后再异步保存 pending；保存失败 → 关闭空白标签页 + 剪贴板兜底
    const saved = await pendingHandoffStore.save(text)
    if (!saved) {
      reservation.close()
      await fallbackToClipboard(text)
      return
    }
    handoffPendingMeta = { pending: true, ageMs: 0, characters: text.length }
    ui.hideHandoffPreview()
    const navigated = reservation.navigate()
    ui.setStatus(
      navigated
        ? '已打开新聊天，Handoff 将自动填入输入框（不会自动发送）'
        : '新聊天标签页已被关闭，Handoff 已保留，请重新点击或手动打开新聊天'
    )
    window.setTimeout(() => ui.setStatus(''), 4500)
  }

  /** 注入互斥：resetForRoute 可能连续触发，避免并发双重注入 */
  let handoffInjectInFlight = false

  /**
   * 新建聊天页（无会话 id）读取 pending handoff 并填入 composer。
   * 会话路由直接跳过（不多一次 storage 读）；无 pending 时页面零行为。
   * 注入等待期间路由切换（用户已离开新聊天页）→ injector shouldAbort 放弃，
   * 草稿绝不写进非目标页面（规格 #31）。
   */
  async function maybeInjectPendingHandoff(): Promise<void> {
    if (provider.getConversationId() !== null) return
    if (handoffInjectInFlight) return
    const gen = conversationGeneration
    handoffInjectInFlight = true
    try {
      const startedAt = Date.now()
      const result = await injectPendingHandoff(getContinuationCapability(), pendingHandoffStore, {
        shouldAbort: () => gen !== conversationGeneration
      })
      if (gen !== conversationGeneration) return
      if (result === 'injected') {
        handoffPendingMeta = {
          pending: false,
          ageMs: Date.now() - startedAt,
          characters: null
        }
        ui.setStatus('已填入上一段会话的 Handoff，请检查后手动发送')
        window.setTimeout(() => {
          if (gen === conversationGeneration) ui.setStatus('')
        }, 5000)
      }
    } finally {
      handoffInjectInFlight = false
    }
  }

  /** 仅当会话已被用户缓存时才调度自动保存（v1.1 不做全量自动缓存） */
  function scheduleCacheSave(complete: boolean): void {
    if (!cacheStore.isAvailable()) return
    const conversationId = provider.getConversationId()
    if (!conversationId || conversationId !== activeCachedId) return
    pendingSave = { conversationId, complete: complete || (pendingSave?.complete ?? false) }
    scheduleAutoSave()
  }

  /** 序列化当前 store 并落盘。写入前校验会话 key，绝不把 A 会话的数据写进 B 的缓存。 */
  async function writeCacheSnapshot(conversationId: string, complete: boolean): Promise<void> {
    try {
      if (store.conversationKey !== conversationId) return
      const snapshot = serializeConversation(store, {
        provider: 'chatgpt',
        conversationId,
        complete,
        pinned: true,
        createdAt: activeCreatedAt
      })
      const saved = await cacheStore.put(snapshot)
      syncCacheAvailability()
      if (!saved) return // 被动自动保存失败：只同步可用性，不打扰用户
    } catch (err) {
      reportError('cache.write', err)
    }
  }

  /** 路由离开 / 重置前：取消定时器并立即落盘待写快照（快照在 store.reset 之前序列化） */
  function flushPendingSave(): void {
    scheduleAutoSave.cancel()
    const pending = pendingSave
    pendingSave = null
    if (pending) void writeCacheSnapshot(pending.conversationId, pending.complete)
  }

  /**
   * 路由进入：异步读取导航缓存并 hydrate。
   * 读取期间用户可能已切走（SPA）：generation + conversationId 双重校验，
   * 任一变化即丢弃本次结果，绝不 hydrate 到其他会话。
   *
   * 与 Live DOM 相关的步骤（reconcile / stale 检查）通过 ready 队列推迟到
   * Conversation Transition Gate 就绪之后（规格 #17 Phase B）—— 缓存 hydrate
   * 本身只写 Store 数据、不读 Live DOM，可先行渲染目录（cache-first）；
   * 就绪前的 indexer.scan 会解析仍挂载的旧会话 DOM，必须等待。
   */
  async function loadCachedConversation(conversationId: string): Promise<void> {
    const gen = conversationGeneration
    try {
      const readStart = performance.now()
      const cached = await cacheStore.get('chatgpt', conversationId)
      perf.markCacheRead(performance.now() - readStart)
      if (gen !== conversationGeneration) return
      if (provider.getConversationId() !== conversationId) return
      // v1.2.2：null 有两种语义 —— 真 miss（store 仍可用）vs storage 失败（已不可用）。
      // 不可用时不关 UI 缓存状态（★ 不抹掉），静默退出走 Live-only。
      if (!syncCacheAvailability()) return
      if (!cached) {
        ui.setCached(false)
        return
      }
      ui.setCached(true)
      activeCachedId = conversationId
      activeCreatedAt = cached.createdAt
      hydratedTurnIds = new Set(cached.turns.map((turn) => turn.id))
      void cacheStore.touch('chatgpt', conversationId).then(() => {
        // touch 失败同样只同步可用性（CacheStore 内部已 catch，无 unhandled rejection）
        syncCacheAvailability()
      })

      hydrating = true
      let hydrated = 0
      try {
        const hydrateStart = performance.now()
        hydrated = hydrateCachedConversation(store, cached)
        lastHydrateMs = performance.now() - hydrateStart
        perf.markCacheHydrate(lastHydrateMs)
        if (hydrated > 0) {
          // 缓存命中：立即渲染目录（纯 Store 数据，先于 Live DOM 就绪），
          // 与 Live DOM 的调和推迟到 DOM 就绪后执行
          store.commit('structure')
        }
      } finally {
        hydrating = false
      }
      if (hydrated > 0) {
        runWhenTransitionReady(() => {
          // 就绪后与已存在的 Live DOM 调和；路由再变则丢弃（generation 守卫）
          if (gen !== conversationGeneration) return
          const reconcileStart = performance.now()
          indexer.scan(true)
          lastReconcileMs = performance.now() - reconcileStart
          // 缓存此前已确认 complete（到顶）：本轮路由直接继承到顶证据
          //（不再需要任何补全）；stale 检查同理推迟到 Live 数据进入之后
          if (cached.complete === true) {
            reachedTop = true
            refreshHistoryCoverageUi()
          }
          checkCacheStaleness()
        })
      }
    } catch (err) {
      reportError('cache.load', err)
    }
  }

  /**
   * 缓存 stale 判定（分支切换防护）：已挂载 Live user turn ≥3 且与缓存 id 零重叠时，
   * 缓存大概率来自另一条分支（edit / regenerate）—— 丢弃缓存恢复的未挂载 turn，
   * Live Store 优先；随后由 debounce 自动保存以 Live 数据重写缓存。
   */
  function checkCacheStaleness(): void {
    if (!hydratedTurnIds || hydratedTurnIds.size === 0) return
    const liveMountedIds = store.turns
      .filter((turn) => turn.user?.element?.isConnected)
      .map((turn) => turn.id)
    if (!isLikelyStale(hydratedTurnIds, liveMountedIds)) return
    const dropIds = new Set<string>()
    for (const turn of store.turns) {
      if (hydratedTurnIds.has(turn.id) && !turn.user?.element?.isConnected) dropIds.add(turn.id)
    }
    hydratedTurnIds = null
    store.cacheHydrated = false
    // 缓存 complete 语义随 stale 判定失效：到顶证据不再可信，退回 partial
    reachedTop = false
    store.dropTurns(dropIds)
    refreshHistoryCoverageUi()
  }

  // ---------- 两层 Observer + Mutation 管道（v1.2） ----------
  // RootWatch 只管 conversation root 生命周期；Conversation Observer 只管 turn 生命周期。
  // streaming 判定用 Store 元素身份比对（不依赖 id 关系），assistant 首次挂载不会被误忽略。
  let activeRoot: HTMLElement | null = null
  let stopConversationObserver: (() => void) | null = null
  let stopRootWatch: (() => void) | null = null
  let stopStartupScan: (() => void) | null = null

  /** streaming / 流式输出导致的布局漂移 → 去抖 geometry refresh（不触发索引） */
  const debouncedSpyRefresh = debounce(() => spy.refresh(), 300)

  // ---------- Live Write Identity Guard（防御纵深，规格 #19-#22） ----------
  // RouteWatcher 已经很快，但所有 Live DOM → Store 的写入路径仍加最后一道门：
  // 即使未来时序再变，错会话 DOM 也绝不能进入 Store。全部为 O(1) 检查。
  /** 本轮路由 reset 时的身份 key；写入守卫据此核对"身份未被再次切换" */
  let expectedRouteKey: string | null = null

  function isExpectedRouteStillCurrent(): boolean {
    return (
      expectedRouteKey !== null &&
      routeIdentityKey(readRouteIdentity(() => provider.getConversationId())) ===
        expectedRouteKey
    )
  }

  /**
   * Live DOM 已确认可接受：Phase B 完成 + root 仍连接 + 路由身份仍是本轮预期。
   * 三条同时成立才允许 indexer 写入（onDirty / onFullScan / startup scan 共用）。
   */
  function isLiveDomAccepted(): boolean {
    return (
      transitionReadyDone &&
      activeRoot !== null &&
      activeRoot.isConnected &&
      isExpectedRouteStillCurrent()
    )
  }

  // selector 由 Provider 下发（bootstrap 不 import 站点 SELECTORS，边界见 Provider 契约）
  const mutationHints = provider.getMutationHints()

  const pipeline = createMutationPipeline(
    {
      turnSelector: mutationHints.turnSelector,
      assistantUnitSelectors: mutationHints.assistantUnitSelectors,
      // streaming 判定：target 位于 Store 中已挂载 assistant unit 内部（元素身份比对）。
      // assistant 首次挂载时 Store 尚无绑定 → 不满足 → 走 dirty 路径，不会被误忽略（#23/#63）
      isMountedAssistantTarget: (target) => {
        for (const selector of mutationHints.assistantUnitSelectors) {
          const unit = target.closest<HTMLElement>(selector)
          if (!unit) continue
          if (
            store.turns.some(
              (turn) => turn.assistant?.isMounted === true && turn.assistant.element === unit
            )
          ) {
            return true
          }
        }
        return false
      }
    },
    {
      onDirty: (roots) => {
        // root 已断连（路由切换窗口内的迟到回调）→ 丢弃；路由身份已再变 → 同样丢弃，
        // 防止 A 会话数据写入 B Store（#12/#67 + Live Write Identity Guard）
        if (!isLiveDomAccepted()) return
        indexer.scanDirty(roots)
      },
      onFullScan: () => {
        if (!isLiveDomAccepted()) return
        indexer.scan(true)
      },
      onAssistantStream: () => {
        // streaming 导致的布局漂移 → 去抖 geometry refresh（历史补全不再消费流式时间戳：
        // TurnRail 没有任何会因 streaming 而启动的后台任务）
        debouncedSpyRefresh()
      }
    }
  )

  function attachConversationObserver(root: HTMLElement): void {
    stopConversationObserver?.()
    activeRoot = root
    perf.markRootDetected()
    stopConversationObserver = observeConversationTurns(
      root,
      (records) => pipeline.handle(records),
      handleRootLost
    )
    // 被动到顶证据采集跟随当前滚动容器（纯监听，绝不写入 scrollTop）
    topWatch.watch()
    runStartupScan()
  }

  /** root 被替换 / 移除（未伴随路由变化的罕见情况）：重新发现 */
  function handleRootLost(): void {
    stopConversationObserver = null
    activeRoot = null
    // 同一会话 root 暂时丢失：解绑旧容器的到顶采集计时（保留 reachedTop 证据）
    topWatch.detach()
    startRootWatch()
  }

  function startRootWatch(): void {
    stopRootWatch?.()
    stopRootWatch = watchConversationRoot(provider, (root) => {
      stopRootWatch = null
      if (!transitionReadyDone && transitionGate !== null) {
        // Phase B 进行中：root 的出现只是"证据"，能否 attach 由 gate 的
        // 签名比较决定 —— 旧 root 仍挂载时不把它的 mutation 当作新会话（规格 #15）
        transitionGate.probeNow()
        return
      }
      attachConversationObserver(root)
    })
  }

  /** 启动扫描：稳定性退避重试（连续 2 次签名不变即停，交给 Observer） */
  function runStartupScan(): void {
    stopStartupScan?.()
    const gen = conversationGeneration
    // 路由变化与 DOM 交换可能同处一个宏任务（SPA pushState 后同步重渲染）：
    // 立即扫描会把上一会话仍挂载的 DOM 索引进新会话的 Store（跨会话污染）。
    // 首扫推迟一个宏任务；期间出现的新 DOM 由刚挂载的 Observer 增量收获。
    let stabilityStop: (() => void) | null = null
    let deferHandle: number | null = window.setTimeout(() => {
      deferHandle = null
      if (gen !== conversationGeneration) return
      // Live Write Identity Guard：路由身份已再变（迟到的宏任务）→ 绝不扫描
      if (!isLiveDomAccepted()) return
      topWatch.watch()
      indexer.scan(true)
      if (provider.lastLocatedCount > 0) {
        perf.markFirstLiveScan()
        perf.markFirstLiveReconcile()
      }
      stabilityStop = startStartupScan({
        scan: () => {
          if (gen !== conversationGeneration || !isLiveDomAccepted()) return null
          indexer.scan()
          if (provider.lastLocatedCount > 0) perf.markFirstLiveScan()
          return { turnCount: store.turns.length, lastTurnId: store.turns[store.turns.length - 1]?.id }
        },
        hasRoot: () => activeRoot !== null && activeRoot.isConnected,
        onSettled: () => {
          stopStartupScan = null
        }
      })
    }, 0)
    stopStartupScan = () => {
      if (deferHandle !== null) window.clearTimeout(deferHandle)
      stabilityStop?.()
    }
  }


  // ---------- Store → UI / spy / 缓存自动保存 ----------
  store.onChange((kind) => {
    ui.syncFromStore(store, kind)
    // 静态覆盖状态跟随 structure / coverage 变化（纯文本，无后台任务进度）
    if (kind === 'structure' || kind === 'coverage') refreshHistoryCoverageUi()
    if (kind === 'structure') spy.refresh()
    else if (kind === 'elements') debouncedSpyRefresh()
    // 正常会话结构变化（新增消息 / lazy mount / virtualization）同步刷新
    // accepted 基线，防止它漂移成"过时的上一会话描述"（廉价路径，不解析正文）。
    // hydrate 不是 Live 接受（hydrating 抑制）；未 ready / root 断连时不成立。
    if (kind === 'structure' && !hydrating && transitionReadyDone && activeRoot?.isConnected) {
      acceptedDomState.record(readConversationDomSignature(provider))
    }
    // 自动保存只在 turn 结构变化时调度：assistant 流式输出（text）不触发写盘
    if (kind === 'structure' && !hydrating) {
      checkCacheStaleness()
      scheduleCacheSave(false)
    }
  })

  async function handleJump(turnId: string): Promise<void> {
    const gen = conversationGeneration
    try {
      const turn = store.getTurn(turnId)
      if (!turn) return
      const jumped = jumpToTurn(provider, turn)
      if (jumped) {
        spy.setActiveManually(turnId)
        store.activeTurnId = turnId
      } else {
        ui.setStatus('正在定位历史消息…')
        const result = await recoverAndJump(
          provider,
          indexer,
          store,
          turnId,
          (message) => ui.setStatus(message),
          // 路由切换即中止：迟到的恢复绝不把旧 DOM 扫进新 Store（规格 #26）
          { isStale: () => gen !== conversationGeneration }
        )
        if (gen !== conversationGeneration) return
        if (result === 'jumped') {
          ui.setStatus('')
        } else {
          ui.setStatus('未能定位该问题：对应历史尚未加载，可先点击“加载全部历史”')
          window.setTimeout(() => {
            if (gen === conversationGeneration) ui.setStatus('')
          }, 4000)
        }
      }
    } catch (err) {
      reportError('jump', err)
    }
  }

  async function handleLoadHistory(): Promise<void> {
    if (isCaptureRunning() || isRecoverRunning()) return
    const gen = conversationGeneration
    try {
      ui.setBusy(true)
      const result = await captureFullHistory(
        provider,
        indexer,
        store,
        (message) => {
          // 进度提示只在会话未切换时展示
          if (gen === conversationGeneration && message) ui.setStatus(message)
        },
        // 路由切换即中止：迟到的捕获绝不把旧 DOM 扫进新 Store（规格 #26）
        { isStale: () => gen !== conversationGeneration }
      )
      // 会话已切换：丢弃迟到的捕获结果（不改状态、不提示）
      if (gen !== conversationGeneration) return
      // 完整历史捕获确认到顶且当前会话已缓存 → 重新保存并置 complete = true
      if (result.reachedTop && activeCachedId !== null) scheduleCacheSave(true)
      // 显式捕获确认到顶：记录到顶证据（coverage state → complete）
      if (result.reachedTop) {
        reachedTop = true
        refreshHistoryCoverageUi()
      }
      ui.setStatus(
        result.addedTurns > 0 ? `已补充 ${result.addedTurns} 条历史` : '没有发现更多历史消息'
      )
      window.setTimeout(() => {
        if (gen === conversationGeneration && !isCaptureRunning()) ui.setStatus('')
      }, 3500)
    } catch (err) {
      reportError('history-capture', err)
      ui.setStatus('加载历史失败，请重试')
    } finally {
      ui.setBusy(false)
    }
  }

  /**
   * ☆/★：手动缓存 / 移除当前会话的导航缓存（v1.1 仅用户主动缓存，不自动保存陌生会话）。
   * 快照在 await 之前同步序列化：期间即使切走路由，落盘的也是点击时刻的正确数据。
   * v1.2.2：所有路径以 storage 操作的真实返回值为准 —— 写入 / 移除失败绝不显示成功，
   * 并区分"扩展重载"（提示刷新页面）与其他 storage 故障。
   */
  async function handleToggleCache(): Promise<void> {
    if (!syncCacheAvailability()) {
      ui.setStatus(cacheUnavailableMessage())
      window.setTimeout(() => ui.setStatus(''), 3500)
      return
    }
    const conversationId = provider.getConversationId()
    if (!conversationId) return
    const gen = conversationGeneration
    try {
      const existing = await cacheStore.get('chatgpt', conversationId)
      // get 之后 store 可能已因读取失败转为不可用：此时 null ≠ 未缓存，必须先查可用性
      if (!syncCacheAvailability()) {
        ui.setStatus(cacheUnavailableMessage())
        window.setTimeout(() => {
          if (gen === conversationGeneration) ui.setStatus('')
        }, 3500)
        return
      }
      if (existing) {
        // 移除缓存，同时取消该会话的待写自动保存，避免“删完又被写回”
        scheduleAutoSave.cancel()
        pendingSave = null
        const removed = await cacheStore.remove('chatgpt', conversationId)
        syncCacheAvailability()
        if (gen !== conversationGeneration) return
        if (!removed) {
          ui.setStatus(cacheUnavailableMessage())
          window.setTimeout(() => {
            if (gen === conversationGeneration) ui.setStatus('')
          }, 3500)
          return
        }
        activeCachedId = null
        activeCreatedAt = undefined
        hydratedTurnIds = null
        ui.setCached(false)
        ui.setStatus('已移除当前对话缓存')
      } else {
        const snapshot = serializeConversation(store, {
          provider: 'chatgpt',
          conversationId,
          complete: false,
          pinned: true
        })
        const saved = await cacheStore.put(snapshot)
        syncCacheAvailability()
        if (gen !== conversationGeneration) return
        if (!saved) {
          ui.setStatus(cacheUnavailableMessage())
          window.setTimeout(() => {
            if (gen === conversationGeneration) ui.setStatus('')
          }, 3500)
          return
        }
        activeCachedId = conversationId
        activeCreatedAt = snapshot.createdAt
        hydratedTurnIds = new Set(snapshot.turns.map((turn) => turn.id))
        ui.setCached(true)
        ui.setStatus('已缓存当前对话导航')
      }
      window.setTimeout(() => {
        if (gen === conversationGeneration) ui.setStatus('')
      }, 3000)
    } catch (err) {
      reportError('cache.toggle', err)
      ui.setStatus('缓存操作失败，请重试')
      window.setTimeout(() => ui.setStatus(''), 3500)
    }
  }

  // ---------- Route Lifecycle：Phase A（身份切换）+ Phase B（DOM 就绪门） ----------
  // 不变量（规格 #73）：
  //   ROUTE_IDENTITY_CHANGED  → OLD_STATE_INVALID_IMMEDIATELY
  //   NEW_LIVE_DATA           → ONLY_AFTER_DOM_READY
  //   STALE_ASYNC_WORK        → NEVER_MUTATES_NEW_CONVERSATION
  /** Phase B 状态：transition gate 是否仍在等待新会话 DOM */
  let transitioning = false
  /** 本轮路由的 Phase B 已完成（ready 或无需等待）；此后 RootWatch 直接 attach */
  let transitionReadyDone = false
  let transitionGate: ConversationTransitionGate | null = null
  /**
   * 上一会话"已接受 Live DOM"基线（规格：previous baseline 必须来自已接受
   * 状态，绝不在 route event 后临时读当前 DOM —— DOM 可能先于 route event
   * 换成新会话，临时读取会把 previous == current 而永久等待）。
   * Phase B 完成 / 正常 structure 变化时记录；route change 时作为 previous
   * 上报并立即失效；缓存 hydrate 不是 Live 接受，绝不记录。
   */
  const acceptedDomState: AcceptedDomState = createAcceptedDomState()
  /**
   * gate 最近一次探测读到的 DOM 签名（最终 fallback 证据）：ready 前连续
   * 路由切换时，accepted 与 Store fallback 都可能为空，而"最近看到的旧
   * DOM"仍是防止 any-root-ready 放行旧会话的有效证据。
   */
  let lastSeenDomSignature: ConversationDomSignature | null = null
  /** 最近一次完成的 transition 统计快照（gate 停止后诊断 continuity 用） */
  let lastTransitionStats: TransitionGateStats | null = null
  /** 就绪前延迟执行的任务（缓存 reconcile 等 DOM 相关步骤） */
  let readyCallbacks: Array<() => void> = []
  /** 最近一次路由变化的探测来源与就绪耗时（DEBUG 诊断元数据） */
  let lastRouteSource: RouteChangeSource | null = null
  let routeChangedAtMs = 0
  let lastReadyMs: number | null = null

  // ---------- Transition 低干扰提示（UI fallback，规格 #40-#42） ----------
  // transitioning 超过 1.2s 且仍在会话路由时 footer 提示一次"正在同步"；
  // 超过 10s 换为"尚未完成加载"（recovery 仍在继续，绝不要求用户刷新）。
  // 无 toast / 无 spinner / 不闪烁；ready 立即清除，且只清除自己设置的文案。
  const TRANSITION_HINT_MS = 1200
  const TRANSITION_SLOW_HINT_MS = 10_000
  let transitionHintTimer: number | null = null
  let transitionHintShown = false

  function clearTransitionHint(): void {
    if (transitionHintTimer !== null) {
      window.clearTimeout(transitionHintTimer)
      transitionHintTimer = null
    }
    if (transitionHintShown) {
      transitionHintShown = false
      ui.setStatus('')
    }
  }

  function armTransitionHint(): void {
    clearTransitionHint()
    transitionHintTimer = window.setTimeout(() => {
      transitionHintTimer = null
      if (!transitioning) return
      transitionHintShown = true
      ui.setStatus('正在同步当前对话…')
      transitionHintTimer = window.setTimeout(() => {
        transitionHintTimer = null
        if (transitioning) ui.setStatus('当前对话尚未完成加载')
      }, TRANSITION_SLOW_HINT_MS - TRANSITION_HINT_MS)
    }, TRANSITION_HINT_MS)
  }

  /** 就绪前排队、就绪后立即执行（路由再变时整队丢弃，见 resetForRoute） */
  function runWhenTransitionReady(fn: () => void): void {
    if (transitionReadyDone) {
      fn()
      return
    }
    readyCallbacks.push(fn)
  }

  /**
   * Phase B 完成：新会话 DOM 已确认可安全接受。
   * 挂会话 Observer + 启动扫描，并排空就绪队列（缓存调和等）。
   */
  function finishPhaseB(): void {
    if (transitionReadyDone) return
    transitionReadyDone = true
    transitioning = false
    if (routeChangedAtMs > 0) lastReadyMs = Math.round(performance.now() - routeChangedAtMs)
    clearTransitionHint()
    lastTransitionStats = transitionGate?.stats ?? null
    transitionGate?.stop()
    transitionGate = null
    const root = provider.getConversationRoot()
    if (root) attachConversationObserver(root)
    else startRootWatch()
    // 新 DOM 已确认属于当前会话 → 建立下一轮路由的 previous 基线（廉价签名）
    acceptedDomState.record(readConversationDomSignature(provider))
    const queue = readyCallbacks
    readyCallbacks = []
    for (const fn of queue) fn()
  }

  /**
   * Phase B 就绪判定。会话目标：新 DOM 签名证据（root 换绑或首/尾 turn 变化，
   * 规格 #20/#21）；非会话目标：不期待会话 DOM，旧签名退场（root 消失或内容
   * 已不同）即就绪 —— 绝不把仍挂载的旧会话 DOM 索引进非会话 Store。
   */
  function isPhaseBDomReady(
    target: RouteChange['current'],
    previousSignature: ConversationDomSignature | null
  ): (signature: ConversationDomSignature) => boolean {
    return (signature) => {
      if (target.kind !== 'conversation') {
        if (signature.root === null) return true
        return previousSignature === null || !isSameDomSignature(signature, previousSignature)
      }
      return isConversationDomReady(previousSignature, signature)
    }
  }

  function stopTransitionGate(): void {
    transitionGate?.stop()
    transitionGate = null
    readyCallbacks = []
  }
  /**
   * route change 的 previous 基线（绝不读 route-event 后的当前 DOM）：
   * accepted（上一会话最后已接受状态）→ Store + activeRoot 已接受状态
   * → gate 最近一次探测读到的签名 → null（真的一无所知，仅初始启动）。
   * 在 Phase A 拆卸之前调用：activeRoot / Store 此刻仍属上一会话。
   */
  function snapshotPreviousDomState(): ConversationDomSignature | null {
    const fallback =
      activeRoot !== null && store.turns.length > 0
        ? () => ({
            root: activeRoot,
            turnCount: store.turns.length,
            firstTurnId: store.turns[0]?.id ?? null,
            lastTurnId: store.turns[store.turns.length - 1]?.id ?? null
          })
        : null
    return acceptedDomState.snapshot(fallback) ?? lastSeenDomSignature
  }

  function resetForRoute(change: RouteChange | null): void {
    const gen = ++conversationGeneration
    // 初始启动（change = null）接受当前页面已有的 DOM：previousSignature = null
    //（不存在"上一个会话"，任何 root 出现都是合法新内容）
    const identity = change
      ? change.current
      : readRouteIdentity(() => provider.getConversationId())
    const previousSignature = change === null ? null : snapshotPreviousDomState()
    acceptedDomState.invalidate()
    const isReady = isPhaseBDomReady(identity, previousSignature)
    // Live Write Identity Guard 的本轮预期身份（写入路径核对用）
    expectedRouteKey = routeIdentityKey(identity)

    // ---------- Phase A — Identity transition：旧状态立即失效（规格 #17） ----------
    // 先 flush 旧会话的待写缓存：必须在 store.reset 之前序列化旧数据
    flushPendingSave()
    // 新会话身份：旧会话的到顶证据必须失效（规格 #34/#48，A confirmed 不得残留 B）
    topWatch.reset()
    reachedTop = false
    // 终止上一轮仍在等待的 transition（迟到的 ready 队列一并丢弃）
    stopTransitionGate()
    // 停止旧 root 的观察 / 发现 / 启动扫描（迟到回调不得写入新 Store，#12/#67）
    stopStartupScan?.()
    stopStartupScan = null
    stopConversationObserver?.()
    stopConversationObserver = null
    stopRootWatch?.()
    stopRootWatch = null
    activeRoot = null

    spy.stop()
    debouncedSpyRefresh.cancel()
    provider.invalidateDomCache()
    // Store key = Provider 会话 ID（缓存链路兼容：hydrator / 写回都以裸 ID 比对）；
    // 非会话路由按 path 隔离（规格 #33：不再复用恒定的 local-0）
    const key = identity.kind === 'conversation' ? identity.conversationId : `page:${identity.path}`
    store.reset(key)
    ui.handleReset()
    activeCachedId = null
    activeCreatedAt = undefined
    hydratedTurnIds = null
    lastHydrateMs = null
    lastReconcileMs = null
    // Handoff 入口 / 预览跟随新会话（A 的 checkpoint 不影响 B；B 无标记则隐藏入口）
    syncHandoffEntry()

    // ---------- Phase B — DOM readiness：确认后才接受新 Live DOM（规格 #17） ----------
    transitioning = true
    transitionReadyDone = false
    routeChangedAtMs = performance.now()
    lastReadyMs = null
    lastRouteSource = change ? change.source : null
    // 低干扰同步提示只在会话路由武装（首页 / 新建聊天不提示）
    if (identity.kind === 'conversation') armTransitionHint()
    transitionGate = beginConversationTransition({
      probe: () => {
        const signature = readConversationDomSignature(provider)
        lastSeenDomSignature = signature
        return signature
      },
      isReady: (signature) => gen === conversationGeneration && isReady(signature),
      onReady: () => {
        if (gen === conversationGeneration) finishPhaseB()
      }
    })
    // RootWatch 作为 root 生命周期恢复信号（gate 未就绪时只 probe 不 attach；
    // 就绪后由 finishPhaseB / 后续 found 直接 attach）
    startRootWatch()

    // cache-first：缓存读取与 hydrate 不触碰 Live DOM，与 DOM 等待并行；
    // 就绪后的调和通过 ready 队列执行
    if (identity.kind === 'conversation' && cacheStore.isAvailable()) {
      void loadCachedConversation(identity.conversationId)
    }

    // 新建聊天 / 首页：检查是否有待注入的 Handoff（无 pending 时零行为）
    if (identity.kind !== 'conversation') {
      void maybeInjectPendingHandoff()
    }
  }

  const stopRouteWatcher = createRouteWatcher(
    () => readRouteIdentity(() => provider.getConversationId()),
    (change) => resetForRoute(change)
  )

  resetForRoute(null)
  void stopRouteWatcher

  // DEV 钩子：tn-debug=1 时暴露诊断信息（不含任何聊天正文）
  if (DEBUG) {
    /** 扩展版本（chrome.runtime.getManifest）；不可用时 'unknown' */
    function getExtensionVersion(): string {
      try {
        const manifest = (globalThis as unknown as Record<string, any>).chrome?.runtime?.getManifest?.()
        if (typeof manifest?.version === 'string') return manifest.version
      } catch {
        // 非扩展环境（测试台）无 chrome.runtime
      }
      return 'unknown'
    }

    /** extension ID 的 FNV-1a 短 hash（8 位十六进制；隐私合同：绝不输出完整 extension ID） */
    function getExtensionIdHash(): string | null {
      try {
        const id = (globalThis as unknown as Record<string, any>).chrome?.runtime?.id
        if (typeof id !== 'string' || id.length === 0) return null
        let hash = 0x811c9dc5
        for (let i = 0; i < id.length; i++) {
          hash ^= id.charCodeAt(i)
          hash = Math.imul(hash, 0x01000193)
        }
        return (hash >>> 0).toString(16).padStart(8, '0')
      } catch {
        return null
      }
    }

    function buildTurnRailDiagnostics() {
      return buildDiagnostics({
        version: getExtensionVersion(),
        provider,
        store,
        cache: cacheStore,
        performance: perf.snapshot(),
        markers: () => ui.host.shadowRoot?.querySelectorAll('.tn-marker').length ?? 0,
        // Handoff 元数据（纯数字；payload / checkpoint 正文绝不进入诊断）
        checkpointCount: currentCheckpointConversationId()
          ? checkpointStore.count(currentCheckpointConversationId()!)
          : 0,
        handoff: { ...handoffPendingMeta },
        // 历史覆盖快照（纯数字 / 枚举，无正文无 turn ID）
        historyCoverage: computeHistoryCoverage(store, reachedTop),
        // 路由生命周期元数据（纯数字 / 枚举；不含会话 ID / URL，规格 #56/#57）
        routeLifecycle: readRouteLifecycleDiagnostics()
      })
    }

    /** 路由生命周期元数据（纯数字 / 枚举；隐私合同：绝不包含会话 ID / URL） */
    function readRouteLifecycleDiagnostics() {
      const gate = transitionGate
      const stats = gate ? gate.stats : lastTransitionStats
      return {
        generation: conversationGeneration,
        conversationIdPresent: provider.getConversationId() !== null,
        transitioning,
        // transition 阶段枚举：fast → mutation-wait / recovery-poll → ready
        //（真实用户报"侧边栏空"时可直接看到卡在哪个恢复阶段）
        transitionMode: stats ? stats.mode : 'ready',
        transitionProbeCount: stats?.probeCount ?? 0,
        recoveryProbeCount: stats?.recoveryProbeCount ?? 0,
        mutationWakeCount: stats?.mutationWakeCount ?? 0,
        // DEBUG-only boolean：是否存在已接受的 Live 基线（绝不含 turn ID / 选择器）
        acceptedSignaturePresent: acceptedDomState.present,
        lastSource: lastRouteSource,
        lastReadyMs,
        ...stopRouteWatcher.metrics()
      }
    }

    Object.defineProperty(globalThis, '__tnDebug', {      get: () => {
        const sc = provider.getScrollContainer()
        const bounds = sc ? getScrollBounds(sc) : null
        return {
          // Provider 健康（conversationRoot / scrollContainer / turnRoots /
          // userUnits / assistantUnits / strategy）——bootstrap 不自行查询站点 DOM
          ...provider.getDiagnostics(),
          storeTurns: store.turns.length,
          markers: ui.host.shadowRoot?.querySelectorAll('.tn-marker').length ?? 0,
          providerMode: provider.lastStrategyLabel,
          // 生命周期诊断（纯数字 / 短 hash）：bootstrap 次数（正常恒为 1，
          // >1 = 同一页面重复初始化）、扩展版本与 extension ID 短 hash
          //（用于区分"两个扩展副本"造成的重复日志；绝不输出完整 ID）
          bootstrapCount: bootstrapInstanceCount,
          extensionVersion: getExtensionVersion(),
          extensionIdHash: getExtensionIdHash(),
          // 性能指标（TTFR / TTLR / full-vs-incremental / observer 分类；仅元数据）
          performance: perf.snapshot(),
          // 导航缓存指标（只含元数据：命中 / 耗时 / 数量，绝无 prompt 或回答正文）
          cache: {
            ...cacheStore.getStats(),
            hydrateMs: lastHydrateMs,
            reconcileMs: lastReconcileMs,
            hydratedTurns: hydratedTurnIds?.size ?? null
          },
          // Handoff 元数据（纯数字：checkpoint 数 / pending 状态；
          // handoff 文本与 checkpoint 正文绝不暴露）
          handoff: {
            checkpointCount: currentCheckpointConversationId()
              ? checkpointStore.count(currentCheckpointConversationId()!)
              : 0,
            pending: handoffPendingMeta.pending,
            ageMs: handoffPendingMeta.ageMs,
            characters: handoffPendingMeta.characters
          },
          // 历史覆盖快照（纯数字 / 枚举；供浏览器测试与诊断读取）
          historyCoverage: computeHistoryCoverage(store, reachedTop),
          // 路由生命周期（generation / 探测来源 / transition 状态 / 信号计数；
          // 纯数字与枚举元数据，绝不包含会话 ID / URL —— 规格 #39/#56/#67）
          routeLifecycle: readRouteLifecycleDiagnostics(),
          // 滚动几何（真实 ChatGPT 为 column-reverse：scrollTop ∈ [-extent, 0]）
          flexDirection: sc ? window.getComputedStyle(sc).flexDirection : null,
          scrollTop: sc ? sc.scrollTop : null,
          scrollExtent: bounds?.extent ?? null,
          scrollMin: bounds?.min ?? null,
          scrollMax: bounds?.max ?? null,
          atVisualTop: sc ? isAtVisualTop(sc) : null,
          atVisualBottom: sc ? isAtVisualBottom(sc) : null
        }
      }
    })
    ;(globalThis as unknown as Record<string, unknown>).__tn = {
      store,
      provider,
      spy,
      indexer,
      cache: cacheStore,
      recoverLog: getRecoverLog,
      topWatch,
      // DEBUG 跳转钩子：与点击目录项同一 handleJump 路径（jump → 失败时 recoverAndJump）。
      // 供诊断 / 浏览器测试在虚拟化频繁重建 DOM 时稳定触发恢复跳转
      jump: (turnId: string) => void handleJump(turnId),
      resetPerformanceStats: () => perf.reset(),
      // 诊断导出（纯元数据，无聊天正文；见 utils/diagnostics.ts 隐私合同）：
      // 生成 JSON → 尝试写入剪贴板；剪贴板不可用时返回 JSON 字符串。绝不自动发送。
      copyDiagnostics: async (): Promise<string> => {
        const json = JSON.stringify(buildTurnRailDiagnostics(), null, 2)
        try {
          await navigator.clipboard.writeText(json)
          debugLog('TurnRail 诊断已复制到剪贴板')
        } catch {
          debugWarn('剪贴板不可用，诊断 JSON 以返回值提供')
        }
        return json
      }
    }
  }
}

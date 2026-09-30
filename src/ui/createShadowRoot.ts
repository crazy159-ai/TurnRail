import { debounce } from '../utils/debounce'
import { createEl } from '../utils/dom'
import type { ChatProvider } from '../providers/types'
import type { ConversationStore, StoreEvent } from '../conversation/store'
import type { ConversationTurn } from '../conversation/types'
import type { ConversationHealthSnapshot } from '../health/types'
import { getScrollBounds } from '../navigation/scrollGeometry'
import { navigationCss } from './styles'
import { perf } from '../utils/performance'
import { createRail, layoutMarkers, type Rail } from './rail'
import { createOutline, type Outline } from './outline'
import { analyzeConversationHealth } from '../health/analyzer'

export const HOST_ID = 'turnrail-host'

export interface NavigationUiHandlers {
  onJump: (turnId: string) => void
  onLoadHistory: () => void
  onToggleCache: () => void
  /** 标记 / 取消检查点（bootstrap 操作 CheckpointStore 后由 UI 重渲染） */
  onToggleCheckpoint: (turnId: string) => void
  /** 当前会话中该 turn 是否已标记检查点（renderItems 逐项查询） */
  isCheckpointed: (turnId: string) => boolean
  /** Health CTA / 预览"重新生成"：构建并显示 Handoff 预览 */
  onOpenHandoff: () => void
  /** 复制预览文本（text = textarea 当前内容，含用户手改） */
  onHandoffCopy: (text: string) => void
  /** 确认在新聊天继续：保存 pending → 打开新标签页（只填草稿，绝不发送） */
  onHandoffContinue: (text: string) => void
  /** 关闭预览（取消，无副作用） */
  onHandoffCancel: () => void
}

export interface NavigationUi {
  host: HTMLElement
  syncFromStore(store: ConversationStore, kind: StoreEvent): void
  setActive(turnId: string | undefined): void
  handleReset(): void
  setStatus(text: string): void
  /** 后台历史预热状态（footer 文本） */
  setWarmupStatus(text: string): void
  setBusy(busy: boolean): void
  /** 当前会话是否已缓存（★/☆） */
  setCached(cached: boolean): void
  /** 缓存能力可用性（storage 失败时禁用按钮） */
  setCacheEnabled(enabled: boolean): void
  /** 检查点标记变化后按需重建目录（面板打开时立即，关闭时标记 dirty） */
  refreshList(): void
  /** 最近一次健康快照（Handoff 构建输入；无快照为 null） */
  getHealthSnapshot(): ConversationHealthSnapshot | null
  /** Handoff 预览 */
  showHandoffPreview(payload: { text: string; warnings: string[] }): void
  hideHandoffPreview(): void
  /** 面板头 Handoff 入口可见性（checkpoint 存在时显示） */
  setHandoffEntryVisible(visible: boolean): void
  destroy(): void
}

/**
 * UI 编排：创建 Shadow DOM host，组装 rail + outline，
 * 处理 hover 展开 / pin、深浅色跟随、可见性与 marker 布局。
 */
export function createNavigationUi(provider: ChatProvider, handlers: NavigationUiHandlers): NavigationUi {
  const host = document.createElement('div')
  host.id = HOST_ID
  const shadowRoot = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = navigationCss
  shadowRoot.appendChild(style)

  const layer = createEl('div', 'tn-layer')
  shadowRoot.appendChild(layer)

  let storeRef: ConversationStore | null = null
  let pinned = false
  let searchQuery = ''
  let closeTimer = 0

  const rail: Rail = createRail(layer, { onJump: handlers.onJump })
  const outline: Outline = createOutline(layer, {
    onJump: handlers.onJump,
    onLoadHistory: handlers.onLoadHistory,
    onToggleCache: handlers.onToggleCache,
    onToggleCheckpoint: handlers.onToggleCheckpoint,
    onOpenHandoff: handlers.onOpenHandoff,
    onHandoffCopy: handlers.onHandoffCopy,
    onHandoffContinue: handlers.onHandoffContinue,
    onHandoffCancel: handlers.onHandoffCancel,
    onSearchInput: (query) => {
      searchQuery = query
      renderList()
    },
    onClose: () => {
      pinned = false
      outline.close()
    },
    onPinChange: (value) => {
      pinned = value
      if (!value) scheduleClose()
    }
  })
  outline.setCheckpointLookup((turnId) => handlers.isCheckpointed(turnId))

  // ---------- 可见性 ----------
  function applyVisibility(): void {
    const store = storeRef
    // UI 可见性依据会话容器是否存在（不依赖 URL）；URL 仅用于 conversationKey
    const hasConversation = provider.hasConversation()
    const userTurns = store ? store.turns.filter((turn) => turn.user).length : 0
    // 缓存命中且在会话路由上 → 缓存目录不等 conversation root 出现即可见
    //（TTFR 只受 chrome.storage 读取 + UI mount 影响，规格 #94）
    const cachedOutlineReady = store !== null && userTurns > 0 && provider.isConversationRoute()
    const detectFailed = hasConversation && userTurns === 0 && provider.hasRecognizableContent()
    const showAll = (hasConversation || cachedOutlineReady) && (userTurns > 0 || detectFailed)
    const wasHidden = layer.classList.contains('tn-hidden')
    layer.classList.toggle('tn-hidden', !showAll)
    if (wasHidden && showAll) perf.markFirstRailVisible()
    rail.setFailed(detectFailed)
    rail.setVisible(userTurns > 0 || detectFailed)
    if (userTurns === 0 && !detectFailed) outline.close()
    return
  }

  // ---------- 渲染 ----------
  function computeFractions(turns: ConversationTurn[]): (number | null)[] {
    const container = provider.getScrollContainer()
    const containerRect = container?.getBoundingClientRect() ?? null
    const bounds = container ? getScrollBounds(container) : null
    const docHeight = document.documentElement.scrollHeight
    return turns.map((turn) => {
      const element = turn.user?.element ?? turn.root
      if (!element?.isConnected) return null
      const rect = element.getBoundingClientRect()
      if (container && containerRect && bounds) {
        // 内容坐标（相对内容视觉顶部），normal 与 column-reverse 统一：
        // rect.top - containerRect.top + (scrollTop - min)
        const contentY = rect.top - containerRect.top + (container.scrollTop - bounds.min)
        return Math.min(1, Math.max(0, contentY / Math.max(1, container.scrollHeight)))
      }
      const top = rect.top + window.scrollY
      return Math.min(1, Math.max(0, top / Math.max(1, docHeight)))
    })
  }

  function renderRail(): void {
    const store = storeRef
    if (!store) return
    // 目录粒度 = 用户提问；assistant-only turn（虚拟化窗口切开 pair 的边缘情况）不渲染
    const turns = store.turns.filter((turn) => turn.user)
    if (turns.length === 0) {
      rail.render([], { tops: [], railHeight: 0, markerHeight: 0 })
      return
    }
    const layout = layoutMarkers(computeFractions(turns), window.innerHeight)
    rail.render(turns, layout)
  }

  let outlineDirty = false
  // 健康重算以 Store 的 semanticRevision 为准（structure / user-text 递增）：
  // - assistant 流式（assistant-text）与纯元素绑定（elements）不推进修订号，
  //   物理上不会触发重算 —— 流式优化合同由事件语义保证，无需拼接全文 signature；
  // - 历史上用"末轮全文 signature"去重，既复制 prompt 又漏检早期 turn 的修改。
  let lastHealthRevision = -1
  let lastHealthSnapshot: ConversationHealthSnapshot | null = null

  function renderHealth(): void {
    const store = storeRef
    if (!store) {
      outline.setHealth(null)
      lastHealthRevision = -1
      lastHealthSnapshot = null
      return
    }
    if (store.semanticRevision === lastHealthRevision) return
    lastHealthRevision = store.semanticRevision
    perf.markHealthAnalyze()
    lastHealthSnapshot = analyzeConversationHealth(store.turns)
    outline.setHealth(lastHealthSnapshot)
  }

  function renderList(): void {
    const store = storeRef
    if (!store) return
    // 面板关闭时不重建目录（streaming / 虚拟化滚动期间的 structure/elements
    // 事件不再产生任何 DOM 工作）；打开时按需重建一次
    if (!outline.isOpen()) {
      outlineDirty = true
      perf.outlineSkipped()
      return
    }
    outlineDirty = false
    perf.outlineFull()
    const detectFailed = store.turns.length === 0 && provider.hasConversation() && provider.hasRecognizableContent()
    outline.renderItems(store.turns, searchQuery, detectFailed)
  }

  // ---------- 事件与生命周期 ----------
  function openPanel(): void {
    if (outlineDirty) {
      outlineDirty = false
      const store = storeRef
      if (store) {
        perf.outlineFull()
        const detectFailed = store.turns.length === 0 && provider.hasConversation() && provider.hasRecognizableContent()
        outline.renderItems(store.turns, searchQuery, detectFailed)
      }
    }
    outline.open()
  }



  function scheduleClose(): void {
    if (pinned) return
    window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(() => outline.close(), 280)
  }

  rail.element.addEventListener('mouseenter', () => {
    window.clearTimeout(closeTimer)
    openPanel()
    renderRail()
  })
  rail.element.addEventListener('mouseleave', () => scheduleClose())
  outline.element.addEventListener('mouseenter', () => window.clearTimeout(closeTimer))
  outline.element.addEventListener('mouseleave', () => scheduleClose())

  shadowRoot.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') {
      pinned = false
      outline.close()
    }
  })

  // 窗口尺寸变化 → 重算 marker 布局
  const recomputeOnResize = debounce(() => renderRail(), 200)
  window.addEventListener('resize', recomputeOnResize, { passive: true })

  // 滚动静止后重算一次布局（捕获流式输出导致的位移），非滚动帧内不做矩形读取
  const recomputeOnSettle = debounce(() => renderRail(), 900)
  let scrollTarget: HTMLElement | Window | null = null
  let detachScroll: (() => void) | null = null
  function refreshScrollListener(): void {
    const container = provider.getScrollContainer()
    const target: HTMLElement | Window = container ?? window
    if (scrollTarget === target) return
    detachScroll?.()
    scrollTarget = target
    target.addEventListener('scroll', recomputeOnSettle, { passive: true })
    detachScroll = () => target.removeEventListener('scroll', recomputeOnSettle)
  }

  // ---------- 深浅色跟随 ----------
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  function applyTheme(): void {
    let dark: boolean
    if (document.documentElement.classList.contains('dark')) {
      dark = true
    } else {
      const background = window.getComputedStyle(document.body).backgroundColor
      const match = background.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
      if (match) {
        const red = Number(match[1])
        const green = Number(match[2])
        const blue = Number(match[3])
        dark = (0.299 * red + 0.587 * green + 0.114 * blue) / 255 < 0.5
      } else {
        dark = darkQuery.matches
      }
    }
    host.classList.toggle('tn-dark', dark)
  }
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme']
  })
  darkQuery.addEventListener('change', applyTheme)
  applyTheme()

  // ---------- 对外接口 ----------
  function syncFromStore(store: ConversationStore, kind: StoreEvent): void {
    storeRef = store
    applyVisibility()
    if (layer.classList.contains('tn-hidden')) return
    if (kind === 'structure' || kind === 'elements' || kind === 'user-text') {
      renderRail()
      renderList()
      outline.setCount(store.turns.filter((turn) => turn.user).length)
      refreshScrollListener()
    }
    // 健康重算：structure / user-text 触发；'assistant-text'（流式快路径）
    // 与 'elements'（纯 DOM 绑定）绝不重算 —— 由 semanticRevision 去重兜底
    if (kind === 'structure' || kind === 'user-text') renderHealth()
  }

  function setActive(turnId: string | undefined): void {
    rail.setActive(turnId)
    outline.setActive(turnId)
  }

  /** 检查点标记变化后重建目录（面板关闭时 renderList 自动转 dirty） */
  function refreshList(): void {
    renderList()
  }

  function getHealthSnapshot(): ConversationHealthSnapshot | null {
    return lastHealthSnapshot
  }

  function showHandoffPreview(payload: { text: string; warnings: string[] }): void {
    outline.showHandoffPreview(payload)
  }

  function hideHandoffPreview(): void {
    outline.hideHandoffPreview()
  }

  function setHandoffEntryVisible(visible: boolean): void {
    outline.setHandoffEntryVisible(visible)
  }

  function handleReset(): void {
    searchQuery = ''
    outline.clearSearch()
    outline.close()
    outline.setStatus('')
    outline.setWarmupStatus('')
    outline.setCount(0)
    outline.setCached(false)
    outline.setHealth(null)
    outline.hideHandoffPreview()
    outline.setHandoffEntryVisible(false)
    lastHealthRevision = -1
    lastHealthSnapshot = null
    rail.render([], { tops: [], railHeight: 0, markerHeight: 0 })
    rail.setActive(undefined)
    layer.classList.add('tn-hidden')
  }

  function destroy(): void {
    themeObserver.disconnect()
    darkQuery.removeEventListener('change', applyTheme)
    window.removeEventListener('resize', recomputeOnResize)
    detachScroll?.()
    recomputeOnResize.cancel()
    recomputeOnSettle.cancel()
    window.clearTimeout(closeTimer)
    host.remove()
  }

  return { host, syncFromStore, setActive, handleReset, setStatus: outline.setStatus, setWarmupStatus: outline.setWarmupStatus, setBusy: outline.setBusy, setCached: outline.setCached, setCacheEnabled: outline.setCacheEnabled, refreshList, getHealthSnapshot, showHandoffPreview, hideHandoffPreview, setHandoffEntryVisible, destroy }
}

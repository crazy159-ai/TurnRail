import { debounce } from '../utils/debounce'
import { createEl } from '../utils/dom'
import type { ChatProvider } from '../providers/types'
import type { ConversationStore, StoreEvent } from '../conversation/store'
import type { ConversationTurn } from '../conversation/types'
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
}

export interface NavigationUi {
  host: HTMLElement
  syncFromStore(store: ConversationStore, kind: StoreEvent): void
  setActive(turnId: string | undefined): void
  handleReset(): void
  setStatus(text: string): void
  setBusy(busy: boolean): void
  /** 当前会话是否已缓存（★/☆） */
  setCached(cached: boolean): void
  /** 缓存能力可用性（storage 失败时禁用按钮） */
  setCacheEnabled(enabled: boolean): void
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
  let healthSignature = ''

  // 健康分只在 structure 事件时重算，且经 signature 去重：
  // - 'text' 事件 = assistant 流式输出快路径（见 indexer 快路径注释），健康语义信号
  //   只读 user prompt，不会变；流式期间每个文本批都重算会毁掉 v1.2 的流式优化。
  // - 'elements' 只换 DOM 绑定，同样不重算。
  function renderHealth(): void {
    const store = storeRef
    if (!store) {
      outline.setHealth(null)
      healthSignature = ''
      return
    }
    const userTurns = store.turns.filter((turn) => turn.user)
    const last = userTurns[userTurns.length - 1]
    const signature = `${userTurns.length}:${last?.id ?? ''}:${last?.user?.text ?? ''}`
    if (signature === healthSignature) return
    healthSignature = signature
    outline.setHealth(analyzeConversationHealth(store.turns))
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
    if (kind === 'structure' || kind === 'elements') {
      renderRail()
      renderList()
      outline.setCount(store.turns.filter((turn) => turn.user).length)
      renderHealth()
      refreshScrollListener()
    }
    // 'text'（assistant 流式）刻意不触发健康重算：语义信号只依赖 user prompt，
    // 结构未变时重算纯属浪费，且会在流式期间造成每批一次的全量分析。
  }

  function setActive(turnId: string | undefined): void {
    rail.setActive(turnId)
    outline.setActive(turnId)
  }

  function handleReset(): void {
    searchQuery = ''
    outline.clearSearch()
    outline.close()
    outline.setStatus('')
    outline.setCount(0)
    outline.setCached(false)
    outline.setHealth(null)
    healthSignature = ''
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

  return { host, syncFromStore, setActive, handleReset, setStatus: outline.setStatus, setBusy: outline.setBusy, setCached: outline.setCached, setCacheEnabled: outline.setCacheEnabled, destroy }
}

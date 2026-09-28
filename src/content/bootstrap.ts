import { ChatGptProvider } from '../providers/chatgpt'
import { ConversationStore } from '../conversation/store'
import { ConversationIndexer } from '../conversation/indexer'
import { captureFullHistory, isCaptureRunning } from '../conversation/historyCapture'
import { ScrollSpy } from '../navigation/scrollSpy'
import { jumpToTurn } from '../navigation/jump'
import { isRecoverRunning, recoverAndJump, getRecoverLog } from '../navigation/recoverTarget'
import { createNavigationUi } from '../ui/createShadowRoot'
import { startDomObserver } from './observers'
import { createRouteWatcher } from './routeWatcher'
import { isAtVisualBottom, isAtVisualTop, getScrollBounds } from '../navigation/scrollGeometry'
import { DEBUG, reportError } from '../utils/logger'

/**
 * 组装全部模块并管理生命周期：
 * 路由变化 → 停止 spy / 清缓存 / 重置 store → 重新扫描 → 观察器继续增量更新。
 */
export function bootstrap(): void {
  const provider = new ChatGptProvider()
  const store = new ConversationStore()
  const indexer = new ConversationIndexer(provider, store)

  const ui = createNavigationUi(provider, {
    onJump: (turnId) => void handleJump(turnId),
    onLoadHistory: () => void handleLoadHistory()
  })
  document.body.appendChild(ui.host)

  const spy = new ScrollSpy(store, provider, (turnId) => {
    store.activeTurnId = turnId
    ui.setActive(turnId)
  })

  store.onChange((kind) => {
    ui.syncFromStore(store, kind)
    if (kind === 'structure' || kind === 'elements') spy.refresh()
  })

  let routeEpoch = 0
  let retryTimer = 0

  async function handleJump(turnId: string): Promise<void> {
    try {
      const turn = store.getTurn(turnId)
      if (!turn) return
      const jumped = jumpToTurn(provider, turn)
      if (jumped) {
        spy.setActiveManually(turnId)
        store.activeTurnId = turnId
      } else {
        ui.setStatus('正在定位历史消息…')
        const result = await recoverAndJump(provider, indexer, store, turnId, (message) =>
          ui.setStatus(message)
        )
        if (result === 'jumped') {
          ui.setStatus('')
        } else {
          ui.setStatus('未能定位该问题：对应历史尚未加载，可先点击“加载全部历史”')
          window.setTimeout(() => ui.setStatus(''), 4000)
        }
      }
    } catch (err) {
      reportError('jump', err)
    }
  }

  async function handleLoadHistory(): Promise<void> {
    if (isCaptureRunning() || isRecoverRunning()) return
    try {
      ui.setBusy(true)
      const result = await captureFullHistory(provider, indexer, store, (message) => {
        if (message) ui.setStatus(message)
      })
      ui.setStatus(
        result.addedTurns > 0 ? `已补充 ${result.addedTurns} 条历史` : '没有发现更多历史消息'
      )
      window.setTimeout(() => {
        if (!isCaptureRunning()) ui.setStatus('')
      }, 3500)
    } catch (err) {
      reportError('history-capture', err)
      ui.setStatus('加载历史失败，请重试')
    } finally {
      ui.setBusy(false)
    }
  }

  function resetForRoute(): void {
    routeEpoch++
    window.clearInterval(retryTimer)
    const conversationId = provider.getConversationId()
    const key = conversationId ?? `local-${routeEpoch}`

    spy.stop()
    provider.invalidateDomCache()
    store.reset(key)
    ui.handleReset()

    // 立即扫描 + 短周期重试，覆盖 SPA 异步渲染
    indexer.scan(true)
    let attempts = 0
    retryTimer = window.setInterval(() => {
      attempts++
      indexer.scan()
      if (attempts >= 8) window.clearInterval(retryTimer)
    }, 400)
  }

  const stopDomObserver = startDomObserver(() => indexer.scan())
  const stopRouteWatcher = createRouteWatcher(() => resetForRoute())

  resetForRoute()
  void stopDomObserver
  void stopRouteWatcher

  // DEV 钩子：tn-debug=1 时暴露诊断信息（不含任何聊天正文）
  if (DEBUG) {
    Object.defineProperty(globalThis, '__tnDebug', {
      get: () => {
        const sc = provider.getScrollContainer()
        const bounds = sc ? getScrollBounds(sc) : null
        return {
          conversationRoot: !!provider.getConversationRoot(),
          scrollContainer: !!sc,
          turnRoots: document.querySelectorAll(
            '[data-thread-find-target="conversation"] [data-turn-key]'
          ).length,
          userUnits: document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]').length,
          assistantUnits: document.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]').length,
          userBubbles: document.querySelectorAll('[data-user-message-bubble="true"]').length,
          assistantMarkdown: document.querySelectorAll('[data-markdown-text-style="assistant-message"]').length,
          storeTurns: store.turns.length,
          markers: ui.host.shadowRoot?.querySelectorAll('.tn-marker').length ?? 0,
          providerMode: provider.lastStrategyLabel,
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
      recoverLog: getRecoverLog
    }
  }
}

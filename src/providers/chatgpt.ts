import { collapseWhitespace } from '../utils/dom'
import { debugLog } from '../utils/logger'
import { fnv1a } from '../conversation/stableId'
import type { ChatProvider, LocatedMessage, LocatedTurn, LocatedTurnRoot, ProviderRole } from './types'

/**
 * 2026-09 真实 chatgpt.com DOM 的正式 selector（已由 DevTools 诊断验证）。
 * 站点改版时只需调整本文件。
 */
export const SELECTORS = {
  conversationRoot: '[data-thread-find-target="conversation"]',
  scrollContainer: '[data-app-action-timeline-scroll]',
  turn: '[data-turn-key]',
  userUnit: '[data-chatgpt-search-unit-key$=":user"]',
  assistantUnit: '[data-chatgpt-search-unit-key$=":assistant"]',
  userUnitFallback: '[data-content-search-unit-key$=":user"]',
  assistantUnitFallback: '[data-content-search-unit-key$=":assistant"]',
  userBubble: '[data-user-message-bubble="true"]',
  userMarkdown: '[data-markdown-text-tone="user-message"]',
  assistantRole: '[data-conversation-role="assistant"]',
  assistantMarkdown: '[data-markdown-text-style="assistant-message"]',
  assistantMessage: '[data-chatgpt-selection-message-id]',
  /** 站点标记为非正文（操作 UI 等）的节点 */
  skipContent: '[data-thread-find-skip="true"]'
} as const

const LEGACY_ROLE_ATTR = 'data-message-author-role'
const LEGACY_MESSAGE_ID_ATTR = 'data-message-id'

/**
 * Legacy 有序降级策略（旧 DOM fallback，非主路径）：
 * 站点回滚或特殊页面时逐级尝试。
 */
const LEGACY_MESSAGE_SELECTOR_STRATEGIES: readonly string[] = [
  `[${LEGACY_ROLE_ATTR}="user"],[${LEGACY_ROLE_ATTR}="assistant"]`,
  `article[data-testid^="conversation-turn"] [${LEGACY_ROLE_ATTR}]`,
  `[${LEGACY_MESSAGE_ID_ATTR}]`,
  'article[data-testid^="conversation-turn"]'
]

const TURN_CONTAINER_SELECTOR = '[data-turn-key]'

/** 归一化：合并空白 + trim */
function normalizeText(text: string): string {
  return collapseWhitespace(text)
}

/**
 * 正文清理：克隆节点后移除站点标记的 UI 噪声（操作按钮等），
 * 不触碰附件引用（可能是用户输入的一部分），不破坏真实 prompt 内容。
 */
function extractCleanText(source: HTMLElement): string {
  let text = ''
  try {
    const clone = source.cloneNode(true) as HTMLElement
    clone.querySelectorAll(SELECTORS.skipContent).forEach((node) => node.remove())
    text = clone.innerText || clone.textContent || ''
  } catch {
    text = source.textContent || ''
  }
  return normalizeText(text)
}

function readLegacyRole(element: HTMLElement): ProviderRole {
  const role = element.getAttribute(LEGACY_ROLE_ATTR)
  if (role === 'user' || role === 'assistant') return role
  return 'unknown'
}

function extractLegacyText(messageEl: HTMLElement, role: ProviderRole): string {
  if (role === 'user') {
    const bubble = messageEl.querySelector<HTMLElement>('.whitespace-pre-wrap')
    if (bubble) return normalizeText(bubble.textContent ?? '')
  }
  return normalizeText(messageEl.textContent ?? '')
}

function isScrollable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element)
  const overflowY = style.overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll' && !overflowY.includes('auto')) return false
  return element.scrollHeight - element.clientHeight > 120
}

/** 尾部 legacy 策略（无角色属性时）的启发式角色推断，仅兜底使用 */
function inferLegacyRole(element: HTMLElement): ProviderRole {
  let node: HTMLElement | null = element
  for (let depth = 0; node && depth < 4; depth++) {
    const cls = node.className
    if (typeof cls === 'string') {
      if (cls.includes('markdown') || cls.includes('prose')) return 'assistant'
      if (cls.includes('justify-end') || cls.includes('self-end') || cls.includes('ml-auto')) return 'user'
    }
    node = node.parentElement
  }
  return 'unknown'
}

export class ChatGptProvider implements ChatProvider {
  readonly name = 'chatgpt'

  private cachedScrollContainer: HTMLElement | null = null
  /** DEBUG 诊断字段 */
  lastStrategyLabel = 'none'
  lastLocatedCount = 0

  // ---------- Turn-first 主路径 ----------

  getConversationRoot(): HTMLElement | null {
    return document.querySelector<HTMLElement>(SELECTORS.conversationRoot)
  }

  hasConversation(): boolean {
    return this.getConversationRoot() !== null
  }

  /** 廉价定位：仅收集 turn root（原生顺序 → 按视觉顺序规整），不做正文提取 */
  locateTurnRoots(): LocatedTurnRoot[] {
    const root = this.getConversationRoot()
    if (!root) return []
    const turnRoots = Array.from(root.querySelectorAll<HTMLElement>(SELECTORS.turn)).filter((n) => n.isConnected)
    const located: LocatedTurnRoot[] = turnRoots.map((el) => ({
      id: el.getAttribute('data-turn-key')?.trim() || null,
      root: el
    }))
    // 顺序规整：column-reverse 布局下 DOM 顺序可能与视觉顺序相反。
    // 用首尾 turn 的视口位置判定，保证输出恒为"视觉从上到下"（时间从旧到新），
    // 使 Q 编号 / scrollSpy / 恢复方向在两种布局下语义一致。
    if (located.length >= 2) {
      const firstTop = located[0]!.root.getBoundingClientRect().top
      const lastTop = located[located.length - 1]!.root.getBoundingClientRect().top
      if (firstTop > lastTop) located.reverse()
    }
    return located
  }

  /**
   * 单 turn 解析：full scan 与 incremental scan 共用的唯一 parser（禁止复制解析逻辑）。
   * includeText=false 时只绑定元素 / 读取 ID（跳过 cloneNode + innerText 的文本提取），
   * 供增量路径对"已知 turn 重挂载"做轻量重绑。
   */
  parseTurn(turnRoot: HTMLElement, options?: { includeText?: boolean; positionHint?: number }): LocatedTurn | null {
    const includeText = options?.includeText !== false
    const index = options?.positionHint ?? 0
    const nativeId = turnRoot.getAttribute('data-turn-key')?.trim() || null

    // user unit：不依赖 "fallback-turn-N:0:user" 中的数字，只匹配 ":user" 后缀
    const userUnit =
      turnRoot.querySelector<HTMLElement>(SELECTORS.userUnit) ??
      turnRoot.querySelector<HTMLElement>(SELECTORS.userUnitFallback)
    // assistant unit：同理只匹配 ":assistant" 后缀
    const assistantUnit =
      turnRoot.querySelector<HTMLElement>(SELECTORS.assistantUnit) ??
      turnRoot.querySelector<HTMLElement>(SELECTORS.assistantUnitFallback)

    if (!userUnit && !assistantUnit) return null

    // user 正文：markdown 语气节点 → 气泡 → 整个 unit
    const userContent = userUnit
      ? (userUnit.querySelector<HTMLElement>(SELECTORS.userMarkdown) ??
        userUnit.querySelector<HTMLElement>(SELECTORS.userBubble) ??
        userUnit)
      : null
    const userText = userContent && includeText ? extractCleanText(userContent) : ''

    // assistant 正文：markdown 样式节点 → 整个 unit
    // 注意 [data-conversation-role="assistant"] 是 sr-only H4，不作正文与滚动目标
    const assistantContent = assistantUnit
      ? (assistantUnit.querySelector<HTMLElement>(SELECTORS.assistantMarkdown) ?? assistantUnit)
      : null
    const assistantText = assistantContent && includeText ? extractCleanText(assistantContent) : ''

    const userMessageId = userUnit ? this.getUserMessageId(userUnit, nativeId ?? '') : null
    const assistantMessageId = assistantUnit ? this.getAssistantMessageId(assistantUnit) : undefined

    // Turn 稳定 ID：优先 data-turn-key 原生 UUID；仅缺失时才 fallback
    let turnId = nativeId ?? userMessageId
    if (!turnId) {
      turnId = userText ? `hash-${fnv1a('turn\u0000' + userText)}` : `turn-pos-${index}`
    }

    const user: LocatedMessage | undefined = userUnit
      ? {
          role: 'user',
          text: userText,
          // 导航/跳转目标是 userUnit 本身，而不是 markdown 内部某个 p
          element: userUnit,
          turnContainer: turnRoot,
          externalId: userMessageId ?? turnId
        }
      : undefined

    const assistant: LocatedMessage | undefined = assistantUnit
      ? {
          role: 'assistant',
          text: assistantText,
          element: assistantUnit,
          turnContainer: turnRoot,
          externalId: assistantMessageId ?? null
        }
      : undefined

    return { id: turnId, root: turnRoot, user, assistant }
  }

  /** 主路径：按 conversation root → [data-turn-key] 解析全部 turn（full scan 用） */
  locateTurns(): LocatedTurn[] {
    const root = this.getConversationRoot()
    if (!root) {
      this.lastStrategyLabel = 'none'
      this.lastLocatedCount = 0
      return []
    }
    const located = this.locateTurnRoots()
    const turns: LocatedTurn[] = []
    for (let index = 0; index < located.length; index++) {
      const turn = this.parseTurn(located[index]!.root, { includeText: true, positionHint: index })
      if (turn) turns.push(turn)
    }
    this.lastStrategyLabel = 'turn-first'
    this.lastLocatedCount = turns.length
    return turns
  }

  /** user 消息 ID：search-message-ids 首个 token，缺省回退 turnKey */
  private getUserMessageId(userUnit: HTMLElement, turnId: string): string | null {
    const ids = userUnit.getAttribute('data-chatgpt-search-message-ids')
    const first = ids?.trim().split(/\s+/)[0]
    return first || turnId || null
  }

  /** assistant 消息 ID：selection-message-id → search-message-ids 首个 token */
  private getAssistantMessageId(assistantUnit: HTMLElement): string | undefined {
    const direct = assistantUnit
      .querySelector<HTMLElement>(SELECTORS.assistantMessage)
      ?.getAttribute('data-chatgpt-selection-message-id')
    if (direct) return direct
    const ids = assistantUnit.getAttribute('data-chatgpt-search-message-ids')
    return ids?.trim().split(/\s+/)[0] || undefined
  }

  // ---------- Legacy fallback ----------

  locateMessages(): LocatedMessage[] {
    for (let index = 0; index < LEGACY_MESSAGE_SELECTOR_STRATEGIES.length; index++) {
      const selector = LEGACY_MESSAGE_SELECTOR_STRATEGIES[index]!
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((n) => n.isConnected)
      if (nodes.length === 0) continue

      let messages: LocatedMessage[] = []
      if (index <= 1) messages = this.buildFromLegacyRoleNodes(nodes)
      else if (index === 2) messages = this.buildFromLegacyMessageIdNodes(nodes)
      else messages = this.buildFromLegacyArticles(nodes)

      if (messages.length > 0) {
        debugLog('legacy selector 策略', index, selector)
        this.lastStrategyLabel = `legacy-${index}`
        this.lastLocatedCount = messages.length
        return messages
      }
    }
    this.lastStrategyLabel = 'none'
    this.lastLocatedCount = 0
    return []
  }

  private buildFromLegacyRoleNodes(nodes: HTMLElement[]): LocatedMessage[] {
    const result: LocatedMessage[] = []
    for (const node of nodes) {
      const role = readLegacyRole(node)
      if (role === 'unknown') continue
      result.push({
        role,
        text: extractLegacyText(node, role),
        element: node,
        turnContainer: this.getTurnContainer(node),
        externalId: node.getAttribute(LEGACY_MESSAGE_ID_ATTR)
      })
    }
    return result
  }

  private buildFromLegacyMessageIdNodes(nodes: HTMLElement[]): LocatedMessage[] {
    const result: LocatedMessage[] = []
    for (const node of nodes) {
      const attrRole = readLegacyRole(node)
      const role: ProviderRole = attrRole !== 'unknown' ? attrRole : inferLegacyRole(node)
      result.push({
        role,
        text: extractLegacyText(node, role),
        element: node,
        turnContainer: this.getTurnContainer(node),
        externalId: node.getAttribute(LEGACY_MESSAGE_ID_ATTR)
      })
    }
    return result
  }

  private buildFromLegacyArticles(articles: HTMLElement[]): LocatedMessage[] {
    const result: LocatedMessage[] = []
    for (const article of articles) {
      const userEl = article.querySelector<HTMLElement>('.whitespace-pre-wrap')
      if (userEl) {
        result.push({
          role: 'user',
          text: normalizeText(userEl.textContent ?? ''),
          element: (userEl.closest(`[${LEGACY_ROLE_ATTR}]`) as HTMLElement | null) ?? userEl,
          turnContainer: article,
          externalId:
            (userEl.closest(`[${LEGACY_MESSAGE_ID_ATTR}]`) as HTMLElement | null)?.getAttribute(
              LEGACY_MESSAGE_ID_ATTR
            ) ?? null
        })
      }
      const assistantEl = article.querySelector<HTMLElement>('.markdown, .prose')
      if (assistantEl) {
        result.push({
          role: 'assistant',
          text: normalizeText(assistantEl.textContent ?? ''),
          element: (assistantEl.closest(`[${LEGACY_ROLE_ATTR}]`) as HTMLElement | null) ?? assistantEl,
          turnContainer: article,
          externalId:
            (assistantEl.closest(`[${LEGACY_MESSAGE_ID_ATTR}]`) as HTMLElement | null)?.getAttribute(
              LEGACY_MESSAGE_ID_ATTR
            ) ?? null
        })
      }
      if (!userEl && !assistantEl) {
        result.push({
          role: inferLegacyRole(article),
          text: normalizeText(article.textContent ?? ''),
          element: article,
          turnContainer: article,
          externalId: article.getAttribute(LEGACY_MESSAGE_ID_ATTR)
        })
      }
    }
    return result
  }

  getTurnContainer(element: HTMLElement): HTMLElement | null {
    return (
      element.closest<HTMLElement>(TURN_CONTAINER_SELECTOR) ??
      element.closest<HTMLElement>('article[data-testid^="conversation-turn"], [data-testid^="conversation-turn"]')
    )
  }

  // ---------- 路由 / 滚动容器 ----------

  getConversationId(): string | null {
    const match = location.pathname.match(/\/c\/([A-Za-z0-9-]{8,})/)
    return match ? (match[1] ?? null) : null
  }

  isConversationRoute(): boolean {
    return this.getConversationId() !== null
  }

  getScrollContainer(): HTMLElement | null {
    // 第一优先：真实滚动容器属性
    const current = document.querySelector<HTMLElement>(SELECTORS.scrollContainer)
    if (current) {
      this.cachedScrollContainer = current
      return current
    }
    return this.findLegacyScrollContainer()
  }

  /** legacy fallback：不再作为主路径，仅供旧 DOM / 特殊页面兜底 */
  private findLegacyScrollContainer(): HTMLElement | null {
    const cached = this.cachedScrollContainer
    if (cached && cached.isConnected) return cached
    this.cachedScrollContainer = null

    const anchor =
      document.querySelector<HTMLElement>('main article[data-testid^="conversation-turn"]') ??
      document.querySelector<HTMLElement>(`main [${LEGACY_ROLE_ATTR}]`)
    if (anchor) {
      let node: HTMLElement | null = anchor
      while (node && node !== document.body) {
        if (isScrollable(node)) {
          this.cachedScrollContainer = node
          return node
        }
        node = node.parentElement
      }
    }
    const fallback = document.querySelector<HTMLElement>('main .overflow-y-auto')
    if (fallback && isScrollable(fallback)) {
      this.cachedScrollContainer = fallback
      return fallback
    }
    return null
  }

  invalidateDomCache(): void {
    this.cachedScrollContainer = null
  }
}

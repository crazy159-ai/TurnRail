import { createEl } from '../utils/dom'
import type { ConversationTurn } from '../conversation/types'
import type { ConversationHealthSnapshot } from '../health/types'

export interface OutlineHandlers {
  onJump: (turnId: string) => void
  onLoadHistory: () => void
  onSearchInput: (query: string) => void
  onClose: () => void
  onPinChange: (pinned: boolean) => void
  onToggleCache: () => void
  /** 标记 / 取消检查点（Handoff 必带轮次）；由 bootstrap 操作 CheckpointStore */
  onToggleCheckpoint: (turnId: string) => void
  /** Health CTA / 预览"重新生成"：打开（或重建）Handoff 预览 */
  onOpenHandoff: () => void
  /** 复制预览文本（text = textarea 当前内容，含用户手改） */
  onHandoffCopy: (text: string) => void
  /** 确认在新聊天继续：保存 pending → 打开新标签页（只填草稿，绝不发送） */
  onHandoffContinue: (text: string) => void
  /** 关闭预览（无任何副作用；确认/取消均不产生 pending） */
  onHandoffCancel: () => void
}

export interface Outline {
  element: HTMLElement
  open(): void
  close(): void
  isOpen(): boolean
  setCount(count: number): void
  setHealth(snapshot: ConversationHealthSnapshot | null): void
  renderItems(turns: ConversationTurn[], query: string, detectFailed: boolean): void
  setActive(turnId: string | undefined): void
  setStatus(text: string): void
  setBusy(busy: boolean): void
  clearSearch(): void
  /** ☆/★ 状态同步（含 tooltip / aria-pressed） */
  setCached(cached: boolean): void
  /** storage 不可用时禁用缓存按钮（Live-only 降级） */
  setCacheEnabled(enabled: boolean): void
  /** 注入 checkpoint 查询函数（renderItems 时决定每项的 ★/☆ 状态） */
  setCheckpointLookup(lookup: (turnId: string) => boolean): void
  /** 显示 Handoff 预览（editable；用户可手改后复制） */
  showHandoffPreview(payload: { text: string; warnings: string[] }): void
  hideHandoffPreview(): void
  isHandoffPreviewOpen(): boolean
}

/**
 * hover 展开的浮动目录面板：搜索、问题列表、状态栏与"加载全部历史"。
 * 全部内容用 textContent 渲染，聊天正文绝不作为 HTML 注入。
 */
export function createOutline(parent: HTMLElement, handlers: OutlineHandlers): Outline {
  const element = createEl('section', 'tn-panel')
  element.setAttribute('role', 'region')
  element.setAttribute('aria-label', '对话目录')
  parent.appendChild(element)

  // 头部
  const head = createEl('div', 'tn-panel-head')
  const title = createEl('span', 'tn-panel-title', '对话导航')
  const count = createEl('span', 'tn-count', '0')
  const pinButton = document.createElement('button')
  pinButton.type = 'button'
  pinButton.className = 'tn-icon-btn'
  pinButton.textContent = '📌'
  pinButton.setAttribute('aria-label', '固定面板')
  pinButton.setAttribute('aria-pressed', 'false')
  pinButton.title = '固定 / 取消固定（防止 hover 移开自动收起）'
  pinButton.addEventListener('click', () => {
    const next = pinButton.getAttribute('aria-pressed') !== 'true'
    pinButton.setAttribute('aria-pressed', String(next))
    pinButton.classList.toggle('tn-on', next)
    handlers.onPinChange(next)
  })
  const cacheButton = document.createElement('button')
  cacheButton.type = 'button'
  cacheButton.className = 'tn-icon-btn tn-cache-btn'
  cacheButton.textContent = '☆'
  cacheButton.setAttribute('aria-pressed', 'false')
  cacheButton.title = '缓存当前对话导航'
  cacheButton.setAttribute('aria-label', '缓存当前对话导航')
  cacheButton.addEventListener('click', () => handlers.onToggleCache())
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'tn-icon-btn'
  closeButton.textContent = '×'
  closeButton.setAttribute('aria-label', '关闭目录')
  closeButton.addEventListener('click', handlers.onClose)
  head.append(title, count, cacheButton, pinButton, closeButton)

  // 搜索
  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'tn-search'
  search.placeholder = '搜索当前对话…'
  search.setAttribute('aria-label', '搜索当前对话的问题')
  search.addEventListener('input', () => handlers.onSearchInput(search.value))

  // 对话健康：仅展示 TurnRail 本地启发式结果，不声称知道模型真实上下文窗口。
  // 估算性质说明放 tooltip（#49），常驻空间留给分数与建议
  const health = createEl('section', 'tn-health tn-health-hidden')
  health.setAttribute('aria-live', 'polite')
  const healthTop = createEl('div', 'tn-health-top')
  const healthLabel = createEl('span', 'tn-health-label', '对话健康')
  const healthScore = createEl('strong', 'tn-health-score', '100')
  const healthConf = createEl('span', 'tn-health-conf tn-health-conf-hidden', '低置信度')
  healthTop.append(healthLabel, healthScore, healthConf)
  const healthMessage = createEl('div', 'tn-health-message', '')
  const healthReasons = createEl('div', 'tn-health-reasons', '')
  const healthNote = createEl('div', 'tn-health-note', '')
  // Health → Handoff CTA（watch 弱提示 / organize / new-chat 三档文案；healthy 隐藏）
  const healthCta = document.createElement('button')
  healthCta.type = 'button'
  healthCta.className = 'tn-health-cta'
  healthCta.addEventListener('click', () => handlers.onOpenHandoff())
  health.append(healthTop, healthMessage, healthReasons, healthNote, healthCta)

  // Handoff 预览（覆盖列表区的编辑层）：用户必须先看到完整文本，任何自动发送都被禁止
  const handoffView = createEl('section', 'tn-handoff-view tn-handoff-hidden')
  const handoffHead = createEl('div', 'tn-handoff-head')
  handoffHead.append(createEl('span', 'tn-handoff-title', '交接上下文预览'))
  const handoffClose = document.createElement('button')
  handoffClose.type = 'button'
  handoffClose.className = 'tn-icon-btn'
  handoffClose.textContent = '×'
  handoffClose.setAttribute('aria-label', '关闭交接上下文预览')
  handoffClose.addEventListener('click', () => {
    handlers.onHandoffCancel()
  })
  handoffHead.append(handoffClose)
  const handoffHint = createEl(
    'div',
    'tn-handoff-hint',
    '可编辑。复制后粘贴到新聊天，或在确认后由 TurnRail 填入新聊天输入框（绝不自动发送）。'
  )
  const handoffWarnings = createEl('div', 'tn-handoff-warnings tn-handoff-hidden', '')
  const handoffText = document.createElement('textarea')
  handoffText.className = 'tn-handoff-text'
  handoffText.spellcheck = false
  handoffText.setAttribute('aria-label', '交接上下文内容（可编辑）')
  const handoffActions = createEl('div', 'tn-handoff-actions')
  const handoffCopy = document.createElement('button')
  handoffCopy.type = 'button'
  handoffCopy.className = 'tn-handoff-btn'
  handoffCopy.textContent = '复制'
  handoffCopy.addEventListener('click', () => handlers.onHandoffCopy(handoffText.value))
  const handoffRegen = document.createElement('button')
  handoffRegen.type = 'button'
  handoffRegen.className = 'tn-handoff-btn'
  handoffRegen.textContent = '重新生成'
  handoffRegen.addEventListener('click', () => handlers.onOpenHandoff())
  const handoffCancel = document.createElement('button')
  handoffCancel.type = 'button'
  handoffCancel.className = 'tn-handoff-btn'
  handoffCancel.textContent = '取消'
  handoffCancel.addEventListener('click', () => {
    handlers.onHandoffCancel()
  })
  // 确认继续：在新标签页打开新聊天并自动"填入"输入框；TurnRail 绝不自动发送
  const handoffContinue = document.createElement('button')
  handoffContinue.type = 'button'
  handoffContinue.className = 'tn-handoff-btn tn-handoff-continue'
  handoffContinue.textContent = '在新聊天继续'
  handoffContinue.title = '在新标签页打开 chatgpt.com 新聊天并自动填入输入框（不会自动发送）'
  handoffContinue.addEventListener('click', () => handlers.onHandoffContinue(handoffText.value))
  handoffActions.append(handoffCopy, handoffRegen, handoffContinue, handoffCancel)
  handoffView.append(handoffHead, handoffHint, handoffWarnings, handoffText, handoffActions)

  // 列表
  const list = createEl('div', 'tn-list')
  list.setAttribute('role', 'list')

  // 底部
  const foot = createEl('div', 'tn-panel-foot')
  const status = createEl('span', 'tn-status', '')
  const loadButton = document.createElement('button')
  loadButton.type = 'button'
  loadButton.className = 'tn-load-btn'
  loadButton.textContent = '加载全部历史'
  loadButton.setAttribute('aria-label', '滚动加载当前会话的全部历史消息')
  loadButton.addEventListener('click', () => handlers.onLoadHistory())
  foot.append(status, loadButton)

  element.append(head, search, health, list, handoffView, foot)

  const items = new Map<string, HTMLButtonElement>()
  let activeId: string | undefined
  let lastUserScrollAt = 0
  /** checkpoint 状态查询（bootstrap 注入；缺省视为未标记） */
  let checkpointLookup: (turnId: string) => boolean = () => false

  list.addEventListener('wheel', () => (lastUserScrollAt = Date.now()), { passive: true })
  list.addEventListener('pointerdown', () => (lastUserScrollAt = Date.now()), { passive: true })
  list.addEventListener('touchstart', () => (lastUserScrollAt = Date.now()), { passive: true })

  function open(): void {
    element.classList.add('tn-open')
  }

  function close(): void {
    element.classList.remove('tn-open')
  }

  function isOpen(): boolean {
    return element.classList.contains('tn-open')
  }

  function setCount(value: number): void {
    count.textContent = String(value)
  }

  let lastAnnouncedHealth = ''

  /**
   * 健康卡分层降噪（P2-3）：
   * - healthy 且置信度正常 → 只保留一行"对话健康 NN"；
   * - watch → 建议 + 至多 1 条原因；organize / new-chat → 展开至多 3 条原因；
   * - 低置信度（缓存 preview 覆盖不足）→ 显式标注，并提示覆盖不足，
   *   绝不让用户把截断样本上的分数当成可靠结论；
   * - 估算性质说明放 tooltip，不常驻占空间；
   * - 可访问文本仅在 level / confidence 变化时更新（aria-live 防分数波动刷屏）。
   */
  function setHealth(snapshot: ConversationHealthSnapshot | null): void {
    if (!snapshot || snapshot.evidence.turnCount < 3) {
      health.classList.add('tn-health-hidden')
      health.removeAttribute('data-level')
      healthScore.textContent = ''
      healthConf.classList.add('tn-health-conf-hidden')
      healthMessage.textContent = ''
      healthReasons.textContent = ''
      healthNote.textContent = ''
      healthCta.classList.add('tn-health-cta-hidden')
      lastAnnouncedHealth = ''
      return
    }

    const low = snapshot.confidence === 'low'
    const level = snapshot.level
    health.classList.remove('tn-health-hidden')
    health.dataset.level = level
    healthScore.textContent = String(snapshot.score)
    healthConf.classList.toggle('tn-health-conf-hidden', !low)

    if (level === 'healthy' && !low) {
      healthMessage.textContent = ''
    } else {
      healthMessage.textContent = snapshot.recommendation
    }
    // Handoff CTA：healthy 不显示（低干扰）；watch 弱提示整理、organize/new-chat 引导创建
    if (level === 'healthy') {
      healthCta.classList.add('tn-health-cta-hidden')
    } else {
      healthCta.classList.remove('tn-health-cta-hidden')
      healthCta.textContent =
        level === 'watch' ? '整理关键结论' : level === 'organize' ? '创建交接上下文' : '生成 Handoff'
      healthCta.setAttribute(
        'aria-label',
        level === 'new-chat' ? '生成 Handoff 交接上下文（不会自动发送）' : healthCta.textContent
      )
    }
    const maxReasons = level === 'healthy' ? 0 : level === 'watch' ? 1 : 3
    const reasons = snapshot.reasons.slice(0, maxReasons)
    healthReasons.textContent = reasons.join(' · ')
    healthReasons.classList.toggle('tn-health-reasons-hidden', reasons.length === 0)
    healthNote.textContent = low ? '当前仅掌握部分历史，加载更多后评估更可靠。' : ''
    healthNote.classList.toggle('tn-health-note-hidden', !low)

    health.title = `本地启发式评估（基于已索引的用户提问），不代表 ChatGPT 实际剩余上下文。${snapshot.recommendation}`
    const announced = `${level}:${snapshot.confidence}`
    if (announced !== lastAnnouncedHealth) {
      lastAnnouncedHealth = announced
      health.setAttribute(
        'aria-label',
        `对话健康度 ${snapshot.score} 分${low ? '，低置信度' : ''}。 ${snapshot.recommendation}`
      )
    }
  }

  function setCached(value: boolean): void {
    cacheButton.textContent = value ? '★' : '☆'
    cacheButton.classList.toggle('tn-cached', value)
    cacheButton.setAttribute('aria-pressed', String(value))
    const label = value ? '移除当前对话缓存' : '缓存当前对话导航'
    cacheButton.title = label
    cacheButton.setAttribute('aria-label', label)
  }

  function setCacheEnabled(value: boolean): void {
    cacheButton.disabled = !value
  }

  function setCheckpointLookup(lookup: (turnId: string) => boolean): void {
    checkpointLookup = lookup
  }

  function showHandoffPreview(payload: { text: string; warnings: string[] }): void {
    handoffText.value = payload.text
    if (payload.warnings.length > 0) {
      handoffWarnings.textContent = payload.warnings.join(' ')
      handoffWarnings.classList.remove('tn-handoff-hidden')
    } else {
      handoffWarnings.textContent = ''
      handoffWarnings.classList.add('tn-handoff-hidden')
    }
    handoffView.classList.remove('tn-handoff-hidden')
    list.classList.add('tn-handoff-covered')
  }

  function hideHandoffPreview(): void {
    handoffView.classList.add('tn-handoff-hidden')
    handoffText.value = ''
    handoffWarnings.textContent = ''
    handoffWarnings.classList.add('tn-handoff-hidden')
    list.classList.remove('tn-handoff-covered')
  }

  function isHandoffPreviewOpen(): boolean {
    return !handoffView.classList.contains('tn-handoff-hidden')
  }

  /**
   * 检查点星标（Handoff V1）：低干扰设计 —— 未标记时 hover 才显现，
   * 标记后常驻 ★。item 本身是 <button>，内部不允许再嵌 button，
   * 因此用 span[role="button"] 并阻断冒泡（点击星标不触发跳转）。
   */
  function createCheckpointButton(turnId: string): HTMLSpanElement {
    const marked = checkpointLookup(turnId)
    const star = document.createElement('span')
    star.className = marked ? 'tn-checkpoint-btn tn-checkpointed' : 'tn-checkpoint-btn'
    star.textContent = marked ? '★' : '☆'
    star.setAttribute('role', 'button')
    star.tabIndex = 0
    star.setAttribute('aria-pressed', String(marked))
    star.setAttribute('aria-label', marked ? '取消检查点标记' : '标记为检查点')
    star.title = marked ? '取消检查点标记' : '标记为检查点：生成 Handoff 时必带此轮'
    const toggle = (event: Event): void => {
      event.preventDefault()
      event.stopPropagation()
      handlers.onToggleCheckpoint(turnId)
    }
    star.addEventListener('click', toggle)
    star.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key === 'Enter' || key === ' ') toggle(event)
    })
    return star
  }

  function renderItems(turns: ConversationTurn[], query: string, detectFailed: boolean): void {
    list.textContent = ''
    items.clear()

    const userTurns = turns.filter((turn) => turn.user)
    const normalizedQuery = query.trim().toLowerCase()
    const filtered = normalizedQuery
      ? userTurns.filter(
          (turn) =>
            turn.title.toLowerCase().includes(normalizedQuery) ||
            (turn.user?.text ?? '').toLowerCase().includes(normalizedQuery)
        )
      : userTurns

    if (userTurns.length === 0) {
      const empty = createEl('div', 'tn-empty')
      empty.textContent = detectFailed
        ? '无法识别当前对话内容，ChatGPT 页面结构可能已更新。'
        : '当前会话还没有问题。'
      list.appendChild(empty)
      return
    }
    if (filtered.length === 0) {
      list.appendChild(createEl('div', 'tn-empty', '无匹配结果'))
      return
    }

    const fragment = document.createDocumentFragment()
    filtered.forEach((turn) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'tn-item'
      item.dataset.turnId = turn.id
      item.title = turn.preview || turn.title
      item.setAttribute('role', 'listitem')

      const q = createEl('span', 'tn-q', `Q${turn.index + 1}`)
      const itemTitle = createEl('span', 'tn-item-title', turn.title)
      item.append(q, itemTitle)
      if (!turn.user?.element?.isConnected) {
        item.appendChild(createEl('span', 'tn-flag', '未加载'))
      }
      item.appendChild(createCheckpointButton(turn.id))
      if (turn.id === activeId) item.classList.add('tn-active')
      item.addEventListener('click', () => handlers.onJump(turn.id))

      items.set(turn.id, item)
      fragment.appendChild(item)
    })
    list.appendChild(fragment)
  }

  function setActive(turnId: string | undefined): void {
    if (activeId === turnId) return
    if (activeId) items.get(activeId)?.classList.remove('tn-active')
    activeId = turnId
    const item = turnId ? items.get(turnId) : undefined
    if (item) {
      item.classList.add('tn-active')
      // 面板打开且用户没有正在手动滚动目录时，让当前项保持可见
      if (isOpen() && Date.now() - lastUserScrollAt > 1500) {
        item.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  function setStatus(text: string): void {
    status.textContent = text
  }

  function setBusy(value: boolean): void {
    loadButton.disabled = value
    loadButton.textContent = value ? '加载中…' : '加载全部历史'
  }

  function clearSearch(): void {
    search.value = ''
    handlers.onSearchInput('')
  }

  return { element, open, close, isOpen, setCount, setHealth, renderItems, setActive, setStatus, setBusy, clearSearch, setCached, setCacheEnabled, setCheckpointLookup, showHandoffPreview, hideHandoffPreview, isHandoffPreviewOpen }
}

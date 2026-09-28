import { createEl } from '../utils/dom'
import type { ConversationTurn } from '../conversation/types'

export interface OutlineHandlers {
  onJump: (turnId: string) => void
  onLoadHistory: () => void
  onSearchInput: (query: string) => void
  onClose: () => void
  onPinChange: (pinned: boolean) => void
}

export interface Outline {
  element: HTMLElement
  open(): void
  close(): void
  isOpen(): boolean
  setCount(count: number): void
  renderItems(turns: ConversationTurn[], query: string, detectFailed: boolean): void
  setActive(turnId: string | undefined): void
  setStatus(text: string): void
  setBusy(busy: boolean): void
  clearSearch(): void
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
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'tn-icon-btn'
  closeButton.textContent = '×'
  closeButton.setAttribute('aria-label', '关闭目录')
  closeButton.addEventListener('click', handlers.onClose)
  head.append(title, count, pinButton, closeButton)

  // 搜索
  const search = document.createElement('input')
  search.type = 'text'
  search.className = 'tn-search'
  search.placeholder = '搜索当前对话…'
  search.setAttribute('aria-label', '搜索当前对话的问题')
  search.addEventListener('input', () => handlers.onSearchInput(search.value))

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

  element.append(head, search, list, foot)

  const items = new Map<string, HTMLButtonElement>()
  let activeId: string | undefined
  let lastUserScrollAt = 0

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

  return { element, open, close, isOpen, setCount, renderItems, setActive, setStatus, setBusy, clearSearch }
}

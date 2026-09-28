import { createEl } from '../utils/dom'
import type { ConversationTurn } from '../conversation/types'

export interface RailLayout {
  /** 每个 turn 的 marker 顶部像素位置（与 turns 顺序一一对应） */
  tops: number[]
  railHeight: number
  markerHeight: number
}

export interface Rail {
  element: HTMLElement
  render(turns: ConversationTurn[], layout: RailLayout): void
  setActive(turnId: string | undefined): void
  setVisible(visible: boolean): void
  setFailed(failed: boolean): void
}

/**
 * DeepSeek 风格右侧 marker 轨道：
 * fixed overlay，不挤压页面；marker 按消息在内容中的比例定位，
 * 数量多时自动压缩间距，当前项加宽高亮。
 */
export function createRail(parent: HTMLElement, handlers: { onJump: (turnId: string) => void }): Rail {
  const element = createEl('nav', 'tn-rail')
  element.setAttribute('aria-label', '对话导航')
  parent.appendChild(element)

  const buttons = new Map<string, HTMLButtonElement>()
  let activeId: string | undefined
  let failed = false

  function render(turns: ConversationTurn[], layout: RailLayout): void {
    element.textContent = ''
    element.style.height = turns.length > 0 ? `${layout.railHeight}px` : ''
    buttons.clear()

    if (turns.length === 0) {
      if (failed) {
        const dot = createEl('span', 'tn-fail-dot')
        dot.title = '无法识别当前对话（页面结构可能已更新）'
        element.appendChild(dot)
      }
      return
    }

    const fragment = document.createDocumentFragment()
    turns.forEach((turn, index) => {
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.className = 'tn-marker'
      marker.dataset.turnId = turn.id
      marker.style.top = `${layout.tops[index] ?? 0}px`
      marker.style.height = `${layout.markerHeight}px`
      marker.setAttribute('aria-label', `跳转到第 ${index + 1} 个问题：${turn.title}`)
      marker.title = `Q${index + 1} ${turn.title}`
      marker.addEventListener('click', (event) => {
        event.stopPropagation()
        handlers.onJump(turn.id)
      })
      if (turn.id === activeId) marker.classList.add('tn-active')
      buttons.set(turn.id, marker)
      fragment.appendChild(marker)
    })
    element.appendChild(fragment)
  }

  function setActive(turnId: string | undefined): void {
    if (activeId === turnId) return
    if (activeId) buttons.get(activeId)?.classList.remove('tn-active')
    activeId = turnId
    if (turnId) buttons.get(turnId)?.classList.add('tn-active')
  }

  function setVisible(visible: boolean): void {
    element.classList.toggle('tn-hidden', !visible)
  }

  function setFailed(value: boolean): void {
    failed = value
  }

  return { element, render, setActive, setVisible, setFailed }
}

/**
 * 计算 marker 布局：
 * 输入每个 turn 的内容位置比例（0~1，null 表示未挂载需插值），
 * 输出像素 top 数组，保证相邻 marker 最小间距。
 */
export function layoutMarkers(fractions: (number | null)[], viewportHeight: number): RailLayout {
  const count = fractions.length
  if (count === 0) return { tops: [], railHeight: 0, markerHeight: 0 }

  const maxRail = Math.max(120, Math.floor(viewportHeight * 0.7))
  const minRail = Math.min(180, maxRail)
  const spacing = count <= 20 ? 16 : count <= 80 ? 9 : 6
  let railHeight = Math.min(maxRail, Math.max(minRail, count * spacing))
  let markerHeight = Math.min(12, Math.max(3, Math.floor(railHeight / count) - 5))
  let minGap = Math.max(3, markerHeight + 2)
  if (minGap * count > railHeight) {
    railHeight = Math.min(maxRail, minGap * count)
    if (minGap * count > railHeight) {
      minGap = Math.max(2, Math.floor(railHeight / count))
      markerHeight = Math.min(markerHeight, Math.max(2, minGap - 1))
    }
  }

  // 未挂载 turn 的比例：在最近的已挂载邻居之间线性插值，没有邻居时按序号均分
  const resolved: number[] = new Array(count).fill(0)
  const known: number[] = []
  fractions.forEach((fraction, index) => {
    if (fraction !== null) known.push(index)
  })
  fractions.forEach((fraction, index) => {
    if (fraction !== null) {
      resolved[index] = fraction
      return
    }
    const prev = [...known].reverse().find((i) => i < index)
    const next = known.find((i) => i > index)
    if (prev !== undefined && next !== undefined) {
      const ratio = (index - prev) / (next - prev)
      resolved[index] = (fractions[prev] ?? 0) + ((fractions[next] ?? 0) - (fractions[prev] ?? 0)) * ratio
    } else if (prev !== undefined) {
      resolved[index] = Math.min(1, (fractions[prev] ?? 1) + 1 / count)
    } else if (next !== undefined) {
      resolved[index] = Math.max(0, (fractions[next] ?? 0) - 1 / count)
    } else {
      resolved[index] = (index + 0.5) / count
    }
  })

  const tops = resolved.map((fraction) => Math.round(fraction * (railHeight - markerHeight)))
  // 自上而下强制最小间距
  for (let i = 1; i < tops.length; i++) {
    if (tops[i]! - tops[i - 1]! < minGap) {
      tops[i] = tops[i - 1]! + minGap
    }
  }
  // 溢出时整体回压
  const overflow = tops[tops.length - 1]! - (railHeight - markerHeight)
  if (overflow > 0) {
    for (let i = tops.length - 1; i >= 0; i--) {
      tops[i] = Math.max(0, tops[i]! - overflow)
      if (i > 0 && tops[i]! - tops[i - 1]! < minGap) tops[i] = tops[i - 1]! + minGap
    }
  }

  return { tops, railHeight, markerHeight }
}

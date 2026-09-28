/** 最小 Fake DOM：仅支持 mutation 分类器用到的属性选择器（= 与 $=）与 closest/querySelectorAll */

export class FakeTextNode {
  parentElement: FakeElement | null = null
}

export class FakeElement {
  isConnected = true
  parentElement: FakeElement | null = null
  readonly attrs = new Map<string, string>()
  readonly children: FakeElement[] = []

  constructor(attrs: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value)
  }

  append(child: FakeElement): void {
    child.parentElement = this
    this.children.push(child)
  }

  matches(selector: string): boolean {
    const match = selector.match(/^\[([A-Za-z-]+)(?:([$^*])="([^"]*)")?\]$/)
    if (!match) return false
    const attr = match[1]!
    const op = match[2]
    const value = match[3]
    const actual = this.attrs.get(attr)
    if (actual === undefined) return false
    if (!op) return true
    if (op === '=') return actual === value
    if (op === '$=') return value !== undefined && actual.endsWith(value)
    return false
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this
    while (node) {
      if (node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
}

export function asTurnRoot(id: string): FakeElement {
  return new FakeElement({ 'data-turn-key': id })
}

export function asAssistantUnit(key = 'fallback-turn-1:0:assistant'): FakeElement {
  return new FakeElement({ 'data-chatgpt-search-unit-key': key })
}

export function asPlainElement(): FakeElement {
  return new FakeElement()
}

export function record(target: unknown, added: unknown[] = [], removed: unknown[] = []): MutationRecord {
  return { target, addedNodes: added, removedNodes: removed } as unknown as MutationRecord
}

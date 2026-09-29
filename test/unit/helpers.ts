import type { ChatProvider, LocatedMessage, LocatedTurn, ProviderRole } from '../../src/providers/types.ts'
import type { StorageAreaLike } from '../../src/cache/types.ts'
import type { CachedConversation, CachedTurn } from '../../src/cache/types.ts'
import type { ConversationTurn } from '../../src/conversation/types.ts'

/** Node 测试环境的假 HTMLElement：Indexer 只读 isConnected，不调用 DOM API */
export function fakeElement(connected = true): HTMLElement {
  return { isConnected: connected } as unknown as HTMLElement
}

export function makeCachedTurn(id: string, index: number): CachedTurn {
  return { id, index, userMessageId: id, title: `问题 ${id}`, preview: `${id} 的提问内容预览` }
}

export function makeCached(conversationId: string, ids: string[], extra: Partial<CachedConversation> = {}): CachedConversation {
  const now = Date.now()
  return {
    schemaVersion: 1,
    provider: 'chatgpt',
    conversationId,
    createdAt: now - 1000,
    updatedAt: now,
    lastAccessAt: now,
    turnCount: ids.length,
    complete: false,
    pinned: true,
    turns: ids.map((id, index) => makeCachedTurn(id, index)),
    ...extra
  }
}

export function makeTurn(id: string, index: number, text: string): ConversationTurn {
  return {
    id,
    index,
    user: { id, role: 'user' as ProviderRole, text, turnIndex: index, element: undefined, firstSeenAt: 0, isMounted: false },
    title: `问题 ${id}`,
    preview: `${text.slice(0, 40)}`
  }
}

/** Live turn：带假 element（Indexer 调和后 isConnected === true） */
export function liveTurn(id: string, question: string): LocatedTurn {
  const root = fakeElement()
  const user: LocatedMessage = {
    role: 'user',
    text: question,
    element: fakeElement(),
    turnContainer: root,
    externalId: id
  }
  const assistant: LocatedMessage = {
    role: 'assistant',
    text: `${question} 的回答`,
    element: fakeElement(),
    turnContainer: root,
    externalId: `${id}-a`
  }
  return { id, root, user, assistant }
}

/** 最小 ChatProvider 桩：Indexer 只消费 locateTurns / locateMessages */
export function fakeProvider(turns: LocatedTurn[]): ChatProvider {
  return {
    name: 'fake',
    locateTurns: () => turns,
    locateMessages: () => [],
    getConversationRoot: () => null,
    hasConversation: () => true,
    getTurnContainer: () => null,
    getConversationId: () => 'conv-1',
    isConversationRoute: () => true,
    getScrollContainer: () => null,
    invalidateDomCache: () => {},
    locateTurnRoots: () => turns.map((turn) => ({ id: turn.id, root: turn.root })),
    parseTurn: (turnRoot: HTMLElement) => turns.find((turn) => turn.root === turnRoot) ?? null,
    hasRecognizableContent: () => true,
    getMutationHints: () => ({ turnSelector: '[data-turn-key]', assistantUnitSelectors: [] }),
    getDiagnostics: () => ({
      conversationRoot: true,
      scrollContainer: true,
      turnRoots: turns.length,
      userUnits: turns.length,
      assistantUnits: turns.length,
      strategy: 'test'
    }),
    lastStrategyLabel: 'test',
    lastLocatedCount: turns.length
  }
}

/** 内存版 chrome.storage.local（测试注入用） */
export function makeStorage(): StorageAreaLike & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    async get(key: string) {
      return { [key]: data.get(key) }
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    },
    async remove(key: string) {
      data.delete(key)
    },
    dump: () => Object.fromEntries(data)
  }
}

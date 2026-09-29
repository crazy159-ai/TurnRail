import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDiagnostics, type TurnRailDiagnostics } from '../../src/utils/diagnostics.ts'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationCacheStore } from '../../src/cache/cacheStore.ts'
import { fakeProvider, liveTurn, makeStorage } from './helpers.ts'

/**
 * Diagnostics 隐私合同（规格 #63/#65）：
 * 导出 JSON 只允许元数据；绝不包含 prompt / 标题 / preview / 正文 /
 * 会话 UUID / 消息 ID / DOM HTML / URL，也不包含 CacheStats 里的 conversationId。
 */

const SECRET_PROMPT = 'SECRET-PROMPT-我的银行账号是 6222-0000-1111-2222'
const SECRET_CONVERSATION_ID = 'c9f3a1b2-77d4-4e55-9a10-3f8c2b5d6e80'
const SECRET_MESSAGE_ID = 'msg-abc123-secret'

function makeContext(): {
  diagnostics: TurnRailDiagnostics
  store: ConversationStore
} {
  const store = new ConversationStore()
  store.reset(SECRET_CONVERSATION_ID)
  // Store 中塞入含敏感内容的 turn（真实场景：聊天正文 / 标题 / preview）
  const turn = liveTurn(SECRET_MESSAGE_ID, SECRET_PROMPT)
  store.messages.set(turn.id, {
    id: turn.id,
    role: 'user',
    text: SECRET_PROMPT,
    turnIndex: 0,
    element: turn.user!.element,
    firstSeenAt: Date.now(),
    isMounted: true
  })
  store.turns = [
    {
      id: turn.id,
      index: 0,
      root: turn.root,
      user: {
        id: turn.id,
        role: 'user',
        text: SECRET_PROMPT,
        turnIndex: 0,
        element: turn.user!.element,
        firstSeenAt: Date.now(),
        isMounted: true
      },
      assistant: {
        id: `${turn.id}-a`,
        role: 'assistant',
        text: 'ASSISTANT-SECRET-REPLY',
        turnIndex: 0,
        element: turn.assistant!.element,
        firstSeenAt: Date.now(),
        isMounted: true
      },
      title: `TITLE-SECRET-${SECRET_PROMPT.slice(0, 10)}`,
      preview: `PREVIEW-SECRET-${SECRET_PROMPT.slice(0, 20)}`
    }
  ]

  const cache = new ConversationCacheStore(makeStorage())
  // 触发一次 get，让缓存 stats 携带 provider / conversationId（应被导出排除）
  void cache.get('chatgpt', SECRET_CONVERSATION_ID).then(() => undefined)

  const provider = fakeProvider([turn])
  const diagnostics = buildDiagnostics({
    version: '1.2.1-test',
    provider,
    store,
    cache,
    performance: null,
    markers: () => 1
  })
  return { diagnostics, store }
}

/** 递归收集 JSON 树的全部 key */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.add(key)
      collectKeys(child, into)
    }
  }
  return into
}

test('diagnostics: 包含版本 / provider / 计数等元数据', () => {
  const { diagnostics } = makeContext()
  assert.equal(diagnostics.turnrailVersion, '1.2.1-test')
  assert.equal(diagnostics.provider.name, 'fake')
  assert.equal(diagnostics.navigation.storeTurns, 1)
  assert.equal(diagnostics.navigation.mountedTurns, 1)
  assert.equal(diagnostics.navigation.markers, 1)
  assert.equal(diagnostics.route.conversationIdPresent, true)
})

test('diagnostics: 不含聊天正文 / 标题 / preview / 会话 ID / 消息 ID', async () => {
  const { diagnostics } = makeContext()
  // 等 cache.get 完成，确保 stats 已携带 conversationId
  await new Promise((resolve) => setTimeout(resolve, 10))

  const json = JSON.stringify(diagnostics)
  assert.ok(!json.includes(SECRET_PROMPT), '不得包含用户 prompt')
  assert.ok(!json.includes('ASSISTANT-SECRET-REPLY'), '不得包含 assistant 正文')
  assert.ok(!json.includes('TITLE-SECRET'), '不得包含 turn 标题')
  assert.ok(!json.includes('PREVIEW-SECRET'), '不得包含 preview')
  assert.ok(!json.includes(SECRET_CONVERSATION_ID), '不得包含会话 UUID')
  assert.ok(!json.includes(SECRET_MESSAGE_ID), '不得包含消息 ID')
})

test('diagnostics: JSON 树不出现禁止字段名', async () => {
  const { diagnostics } = makeContext()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const keys = collectKeys(diagnostics)
  const FORBIDDEN_KEYS = [
    'title',
    'preview',
    'text',
    'conversationId',
    'messageId',
    'url',
    'href',
    'html',
    'element',
    'providerConversationId'
  ]
  const hits = FORBIDDEN_KEYS.filter((key) => keys.has(key))
  assert.deepEqual(hits, [], `诊断输出出现禁止字段: ${hits.join(', ')}`)
})

test('diagnostics: 缓存字段为白名单子集（available/hit/cachedTurns/complete/pinned/readMs/writeMs）', async () => {
  const { diagnostics } = makeContext()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(
    Object.keys(diagnostics.cache).sort(),
    ['available', 'cachedTurns', 'complete', 'hit', 'pinned', 'readMs', 'writeMs']
  )
  assert.equal(diagnostics.cache.available, true)
})

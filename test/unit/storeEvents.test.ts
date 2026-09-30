import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationIndexer } from '../../src/conversation/indexer.ts'
import type { LocatedTurn } from '../../src/providers/types.ts'
import { fakeProvider, liveTurn } from './helpers.ts'

/**
 * 事件语义合同（P1-1 / P1-2）：
 * - ChangeKind 区分 user-text / assistant-text；
 * - semanticRevision 只被 structure / user-text 推进，assistant-text / elements 不变；
 * - 编辑 user prompt → 必须推进（健康重算依据）；assistant 流式 → 不推进。
 */

/** 可变 fake turns：测试中直接改 user/assistant text 再增量扫描 */
function mutableTurns(): LocatedTurn[] {
  return [liveTurn('A', '第一轮问题'), liveTurn('B', '第二轮问题')]
}

function setup(turns: LocatedTurn[]): { store: ConversationStore; indexer: ConversationIndexer } {
  const store = new ConversationStore()
  store.reset('conv-1')
  const indexer = new ConversationIndexer(fakeProvider(turns), store)
  indexer.scan(true)
  return { store, indexer }
}

test('semanticRevision: structure / user-text 推进，assistant-text / elements 不推进', () => {
  const turns = mutableTurns()
  const { store, indexer } = setup(turns)
  const afterInitial = store.semanticRevision
  assert.ok(afterInitial > 0, '首次全量调和应产生 structure 事件')

  // 无变化增量扫描 → none，不推进
  indexer.scan()
  assert.equal(store.semanticRevision, afterInitial)

  // assistant 文本变化（流式快路径）→ assistant-text，不推进
  turns[0]!.assistant!.text = '流式输出中的部分回答'
  indexer.scan()
  assert.equal(store.semanticRevision, afterInitial)

  // 纯元素变化场景由空扫描路径产生（elements）——直接验证 commit 合同
  store.commit('elements')
  assert.equal(store.semanticRevision, afterInitial)
  store.commit('assistant-text')
  assert.equal(store.semanticRevision, afterInitial)

  // user prompt 文本变化 → user-text，推进
  turns[0]!.user!.text = '编辑后的第一轮问题'
  indexer.scan()
  assert.equal(store.semanticRevision, afterInitial + 1)

  // structure 推进
  store.commit('structure')
  assert.equal(store.semanticRevision, afterInitial + 2)
})

test('semanticRevision: reset 归零（路由切换语义）', () => {
  const { store } = setup(mutableTurns())
  store.commit('structure')
  assert.ok(store.semanticRevision > 0)
  store.reset('conv-2')
  assert.equal(store.semanticRevision, 0)
})

/** #59 Test B：编辑已有 user prompt → 健康分析的修订号依据必须变化（重算触发） */
test('store: 编辑 user prompt 产生 user-text 事件（健康重算依据）', () => {
  const turns = mutableTurns()
  const { store, indexer } = setup(turns)
  let lastKind: string | null = null
  store.onChange((kind) => {
    lastKind = kind
  })

  turns[1]!.user!.text = '还是不对，重新做第二轮。'
  indexer.scan()
  assert.equal(lastKind, 'user-text')

  // 纯 assistant 流式 → assistant-text（健康重算的排除依据）
  turns[1]!.assistant!.text = '继续流式输出的内容'
  indexer.scan()
  assert.equal(lastKind, 'assistant-text')
})

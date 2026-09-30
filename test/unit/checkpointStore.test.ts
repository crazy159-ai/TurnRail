import test from 'node:test'
import assert from 'node:assert/strict'
import { CheckpointStore, checkpointId } from '../../src/handoff/checkpointStore.ts'

/**
 * Checkpoint Store 测试矩阵（规格 #33 Test 1-5）：
 * star/unstar 可逆、同 turn 去重、A→B 路由隔离、抗虚拟化卸载、会话重置后互不可见。
 */

const CONV_A = 'conv-aaaa'
const CONV_B = 'conv-bbbb'

test('checkpoint: star / unstar 完全可逆', () => {
  const store = new CheckpointStore()
  assert.equal(store.count(CONV_A), 0)

  assert.equal(store.toggle(CONV_A, { id: 'turn-1', index: 0 }), true)
  assert.equal(store.isCheckpointed(CONV_A, 'turn-1'), true)
  assert.equal(store.count(CONV_A), 1)

  assert.equal(store.toggle(CONV_A, { id: 'turn-1', index: 0 }), false)
  assert.equal(store.isCheckpointed(CONV_A, 'turn-1'), false)
  assert.equal(store.count(CONV_A), 0)
})

test('checkpoint: 同一 turn 重复标记不产生重复 checkpoint（id 恒定去重）', () => {
  const store = new CheckpointStore()
  const first = store.toggle(CONV_A, { id: 'turn-1', index: 0 })
  assert.equal(first, true)
  // 同一 turn 二次 toggle = 取消（不是新增第二条）；再标记仍是同一条
  assert.equal(store.toggle(CONV_A, { id: 'turn-1', index: 0 }), false)
  assert.equal(store.toggle(CONV_A, { id: 'turn-1', index: 0 }), true)

  const list = store.list(CONV_A)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.id, checkpointId(CONV_A, 'turn-1'))
  assert.equal(list[0]!.turnIndex, 0)
  // id 稳定：同一 (conversationId, turnId) 永远得到同一 checkpoint id
  assert.equal(checkpointId(CONV_A, 'turn-1'), checkpointId(CONV_A, 'turn-1'))
})

test('checkpoint: A → B 路由不串数据，A → B → A 状态保留', () => {
  const store = new CheckpointStore()
  store.toggle(CONV_A, { id: 'turn-a1', index: 0 })
  store.toggle(CONV_A, { id: 'turn-a2', index: 1 })

  // 切到会话 B：B 的列表为空，A 的标记不受影响
  assert.equal(store.count(CONV_B), 0)
  assert.equal(store.list(CONV_B).length, 0)
  assert.equal(store.isCheckpointed(CONV_B, 'turn-a1'), false)
  assert.equal(store.count(CONV_A), 2)

  // B 标记自己的 turn
  store.toggle(CONV_B, { id: 'turn-b1', index: 0 })
  assert.equal(store.count(CONV_B), 1)

  // 回到 A：标记原样保留
  assert.deepEqual(store.list(CONV_A).map((c) => c.turnId), ['turn-a1', 'turn-a2'])
  assert.equal(store.isCheckpointed(CONV_A, 'turn-a1'), true)
  assert.equal(store.isCheckpointed(CONV_A, 'turn-b1'), false)
})

test('checkpoint: 虚拟化卸载（无 DOM 元素）不影响 checkpoint 存在', () => {
  const store = new CheckpointStore()
  // checkpoint 只依赖 {id, index} 定位元数据 —— Store 的 turn 元素被卸载
  //（user.element = undefined）时，元数据仍在 Store 中，checkpoint 照常工作
  store.toggle(CONV_A, { id: 'turn-virt', index: 4 })
  assert.equal(store.isCheckpointed(CONV_A, 'turn-virt'), true)

  const list = store.list(CONV_A)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.turnId, 'turn-virt')
  assert.equal(list[0]!.kind, 'custom')
  assert.equal(list[0]!.status, 'active')
})

test('checkpoint: list 按 turnIndex 升序；setStatus superseded 数据层生效', () => {
  const store = new CheckpointStore()
  store.toggle(CONV_A, { id: 'turn-3', index: 2 })
  store.toggle(CONV_A, { id: 'turn-1', index: 0 })
  store.toggle(CONV_A, { id: 'turn-2', index: 1 })

  assert.deepEqual(store.list(CONV_A).map((c) => c.turnId), ['turn-1', 'turn-2', 'turn-3'])

  assert.equal(store.setStatus(CONV_A, 'turn-2', 'superseded'), true)
  assert.equal(store.list(CONV_A).find((c) => c.turnId === 'turn-2')!.status, 'superseded')
  // 不存在的 turn → false
  assert.equal(store.setStatus(CONV_A, 'turn-404', 'superseded'), false)
})

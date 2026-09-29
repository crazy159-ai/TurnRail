import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyCacheFailure,
  getErrorMessage,
  isExtensionContextInvalidated
} from '../../src/cache/errors.ts'

// ---------- isExtensionContextInvalidated（只认明确的扩展生命周期异常） ----------

/** Case 1：Chrome 原样文案的 Error 对象 */
test('errors: Error("Extension context invalidated.") → true', () => {
  assert.equal(isExtensionContextInvalidated(new Error('Extension context invalidated.')), true)
})

/** Case 2：大小写不敏感 */
test('errors: 大小写变体 → true', () => {
  assert.equal(isExtensionContextInvalidated(new Error('extension context INVALIDATED')), true)
  assert.equal(isExtensionContextInvalidated('Extension Context Invalidated.'), true)
})

/** Case 3：其他 storage 错误绝不误判 */
test('errors: 其他错误 → false', () => {
  assert.equal(isExtensionContextInvalidated(new Error('storage backend failed')), false)
  assert.equal(isExtensionContextInvalidated(new Error('QUOTA_BYTES exceeded')), false)
  assert.equal(isExtensionContextInvalidated(new Error('chrome storage unknown error')), false)
  assert.equal(isExtensionContextInvalidated(new Error('Extension context is gone')), false)
})

/** Case 4：非 Error 的字符串 throw */
test('errors: 字符串 "Extension context invalidated." → true', () => {
  assert.equal(isExtensionContextInvalidated('Extension context invalidated.'), true)
})

/** Case 5：null / undefined / 对象 / 数字等怪值 → false 且不 crash */
test('errors: null / undefined / {} / 数字 → false 且不 crash', () => {
  assert.equal(isExtensionContextInvalidated(null), false)
  assert.equal(isExtensionContextInvalidated(undefined), false)
  assert.equal(isExtensionContextInvalidated({}), false)
  assert.equal(isExtensionContextInvalidated(42), false)
})

// ---------- getErrorMessage ----------

test('errors: getErrorMessage 各类输入均可安全取 message', () => {
  assert.equal(getErrorMessage(new Error('boom')), 'boom')
  assert.equal(getErrorMessage('plain'), 'plain')
  assert.equal(getErrorMessage(null), '')
  assert.equal(getErrorMessage(undefined), '')
  assert.equal(getErrorMessage(42), '42')
  assert.equal(getErrorMessage({}), '[object Object]')
})

// ---------- classifyCacheFailure ----------

test('errors: classifyCacheFailure 只分两类', () => {
  assert.equal(
    classifyCacheFailure(new Error('Extension context invalidated.')),
    'extension-context-invalidated'
  )
  assert.equal(classifyCacheFailure(new Error('quota exceeded')), 'storage-error')
  assert.equal(classifyCacheFailure(null), 'storage-error')
})

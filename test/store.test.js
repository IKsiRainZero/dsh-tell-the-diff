import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMonitorStore } from '../plugin/core/store.js'

/** A stand-in for the Harness `Session`. */
function session(id, cwd = 'C:/w') {
  return { id, header: { cwd } }
}

/** One durable `tool/call` event. */
function call(callId, name, args, time) {
  return { type: 'tool/call', seq: 1, time, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}

test('the store only knows sessions it has observed', () => {
  const store = createMonitorStore({ now: () => 5_000 })
  assert.equal(store.view('s1'), undefined)
  assert.deepEqual(store.list(), [])
})

test('observing one session keeps its cwd and folds its events', () => {
  const store = createMonitorStore({ now: () => 5_000 })
  const target = session('s1', 'C:/work')
  store.observe(target, { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } })
  store.observe(target, call('c1', 'read', { file_path: 'C:/work/src/a.js' }, 2_000))
  const view = store.view('s1')
  assert.equal(view.headline, '正在读取文件 · src/a.js')
  assert.equal(view.running, true)
})

test('events from another session never leak into the first', () => {
  const store = createMonitorStore({ now: () => 5_000 })
  store.observe(session('s1'), { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } })
  store.observe(session('s2'), call('c1', 'bash', { command: 'ls' }, 2_000))
  assert.equal(store.view('s1').activity.length, 0)
  assert.equal(store.view('s2').activity.length, 1)
})

test('a checkpoint on an unseen session starts one, so the tool never throws', () => {
  const store = createMonitorStore({ now: () => 9_000 })
  store.checkpoint('s3', { plain: '还没开始，先看需求。' })
  const view = store.view('s3')
  assert.equal(view.plain, '还没开始，先看需求。')
  assert.equal(view.turn, 0)
})

test('snapshots carry the intervention verdict', () => {
  const store = createMonitorStore({ now: () => 200_000 })
  store.observe(session('s1'), { type: 'turn/start', seq: 1, time: 100_000, data: { turn: 1 } })
  store.observe(session('s1'), call('c1', 'bash', { command: 'pnpm build' }, 100_000))
  assert.equal(store.view('s1').surface, 'card')
})

test('idle sessions are pruned but running ones survive', () => {
  const store = createMonitorStore({ now: () => 10_000_000, retentionMs: 60_000 })
  store.observe(session('idle'), { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } })
  store.observe(session('idle'), { type: 'turn/end', seq: 2, time: 2_000, data: { turn: 1, reason: { kind: 'completed' } } })
  store.observe(session('busy'), { type: 'turn/start', seq: 1, time: 9_999_000, data: { turn: 1 } })
  store.prune()
  assert.equal(store.view('idle'), undefined)
  assert.notEqual(store.view('busy'), undefined)
})

test('forgetting a session drops it', () => {
  const store = createMonitorStore({ now: () => 5_000 })
  store.observe(session('s1'), { type: 'turn/start', seq: 1, time: 1_000, data: { turn: 1 } })
  store.forget('s1')
  assert.equal(store.view('s1'), undefined)
})

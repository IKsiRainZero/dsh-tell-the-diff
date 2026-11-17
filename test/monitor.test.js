import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createState,
  reduce,
  snapshot,
  noteCheckpoint,
  shouldSurface,
  describeTool,
  MAX_RECENT,
} from '../plugin/core/monitor.js'

/** One durable `tool/call` event. */
function call(callId, name, args = {}, time = 1_000) {
  return { type: 'tool/call', seq: 1, time, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}

/** One durable `tool/result` event. */
function result(callId, { isError = false, time = 2_000 } = {}) {
  return {
    type: 'tool/result',
    seq: 2,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, isError, content: [] },
      ...(isError ? { error: { name: 'ToolError', code: 'threw' } } : {}),
    },
  }
}

/** Fold a list of events over a fresh state, seeding the session id and cwd. */
function folded(events) {
  let state = reduce(createState('s1', { cwd: 'C:/w' }), { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } })
  for (const event of events) state = reduce(state, event)
  return state
}

test('an ignored event keeps the same state reference', () => {
  const state = createState('s1')
  const next = reduce(state, { type: 'request/header', seq: 9, time: 1, data: {} })
  assert.equal(next, state)
})

test('a tool call becomes the current activity and its result closes it', () => {
  let state = folded([
    call('c1', 'read', { file_path: 'C:/w/src/app.js' }, 1_000),
    result('c1', { time: 3_500 }),
  ])
  const entry = state.recent.at(-1)
  assert.equal(entry.tool, 'read')
  assert.equal(entry.status, 'ok')
  assert.equal(entry.ms, 2_500)
  assert.equal(entry.detail, 'src/app.js')
  assert.equal(state.current, null)
})

test('a running tool call is current until its result arrives', () => {
  const state = folded([call('c1', 'bash', { command: 'pnpm test' }, 1_000)])
  assert.equal(state.current.tool, 'bash')
  assert.equal(state.current.detail, 'pnpm test')
  assert.equal(state.current.startedAt, 1_000)
})

test('a failed tool records an open issue', () => {
  const state = folded([call('c1', 'bash', { command: 'pnpm test' }), result('c1', { isError: true })])
  assert.equal(state.stats.errors, 1)
  const issue = state.issues.at(-1)
  assert.equal(issue.resolvedAt, null)
  assert.match(issue.label, /命令/)
})

test('a later success on the same tool resolves the open issue', () => {
  const state = folded([
    call('c1', 'bash', { command: 'pnpm test' }),
    result('c1', { isError: true }),
    call('c2', 'bash', { command: 'pnpm test' }),
    result('c2'),
  ])
  assert.ok(state.issues.every(issue => issue.resolvedAt !== null))
})

test('reads and writes accumulate per file, newest activity last', () => {
  const state = folded([
    call('c1', 'read', { file_path: 'C:/w/a.md' }),
    result('c1'),
    call('c2', 'edit', { file_path: 'C:/w/a.md' }),
    result('c2'),
    call('c3', 'write', { file_path: 'C:/w/b.md' }),
    result('c3'),
  ])
  assert.deepEqual(
    state.files.map(file => [file.path, file.name, file.reads, file.edits, file.writes]),
    [['C:/w/a.md', 'a.md', 1, 1, 0], ['C:/w/b.md', 'b.md', 0, 0, 1]],
  )
})

test('describeTool speaks plain language for known and unknown tools', () => {
  assert.equal(describeTool('grep', { pattern: 'TODO' }).label, '搜索内容')
  assert.equal(describeTool('grep', { pattern: 'TODO' }).detail, 'TODO')
  assert.equal(describeTool('mystery_tool', { anything: 1 }).label, 'mystery_tool')
})

test('describeTool survives malformed arguments', () => {
  assert.equal(describeTool('read', 'not json').label, '读取文件')
  assert.equal(describeTool('read', 'not json').detail, '')
})

test('recent activity is capped', () => {
  const events = []
  for (let index = 0; index < MAX_RECENT + 5; index += 1) {
    events.push(call(`c${index}`, 'read', { file_path: `/w/${index}.md` }, index))
    events.push(result(`c${index}`, { time: index + 1 }))
  }
  const state = folded(events)
  assert.equal(state.recent.length, MAX_RECENT)
  assert.equal(state.recent.at(-1).detail, `${MAX_RECENT + 4}.md`)
})

test('reduce never mutates the state it was given', () => {
  const before = folded([call('c1', 'read', { file_path: '/w/a.md' })])
  const frozen = JSON.stringify(before)
  reduce(before, result('c1'))
  assert.equal(JSON.stringify(before), frozen)
})

test('a checkpoint carries the plain-language plan into the snapshot', () => {
  let state = folded([call('c1', 'read', { file_path: '/w/a.md' })])
  state = noteCheckpoint(state, {
    plain: '正在核对需求，还没动代码。',
    steps: [{ title: '读现状', status: 'done' }, { title: '改代码', status: 'doing' }],
    questions: ['要不要保留旧接口？'],
    risks: [],
  }, 5_000)
  const view = snapshot(state, 6_000)
  assert.equal(view.plain, '正在核对需求，还没动代码。')
  assert.equal(view.plan.length, 2)
  assert.equal(view.plan[1].status, 'doing')
  assert.deepEqual(view.questions, ['要不要保留旧接口？'])
  assert.equal(view.headline.includes('读取文件'), true)
})

test('the snapshot headline names the running step, then falls back to idle', () => {
  const running = snapshot(folded([call('c1', 'edit', { file_path: '/w/a.js' })]), 2_000)
  assert.equal(running.headline, '正在修改文件 · a.js')
  const idle = snapshot(folded([call('c1', 'edit', { file_path: '/w/a.js' }), result('c1', { time: 2_000 })]), 9_000)
  assert.equal(idle.headline, '空闲 · 上一步 7 秒前结束')
})

test('shouldSurface stays silent while things are quiet', () => {
  const state = folded([call('c1', 'read', { file_path: '/w/a.md' }), result('c1', { time: 2_000 })])
  assert.equal(shouldSurface(state, 3_000), 'silent')
})

test('shouldSurface raises a card for a long-running step and for repeated failures', () => {
  const slow = folded([call('c1', 'bash', { command: 'pnpm build' }, 1_000)])
  assert.equal(shouldSurface(slow, 1_000 + 91_000), 'card')

  const failing = folded([
    call('c1', 'bash', { command: 'pnpm test' }, 1_000),
    result('c1', { isError: true, time: 2_000 }),
    call('c2', 'bash', { command: 'pnpm test' }, 3_000),
    result('c2', { isError: true, time: 4_000 }),
  ])
  assert.equal(shouldSurface(failing, 5_000), 'card')
})

test('shouldSurface never escalates past card in alpha', () => {
  const state = folded([
    call('c1', 'bash', { command: 'x' }, 1_000),
    result('c1', { isError: true, time: 2_000 }),
    call('c2', 'bash', { command: 'x' }, 3_000),
    result('c2', { isError: true, time: 4_000 }),
  ])
  assert.notEqual(shouldSurface(state, 999_999), 'alert')
})

test('the model\'s own todo list becomes the plan, without being asked for it', () => {
  const state = folded([
    call('t1', 'todo_write', {
      todos: [
        { content: '读一遍现有实现', status: 'completed' },
        { content: '补齐分组逻辑', status: 'in_progress' },
        { content: '跑测试', status: 'pending' },
      ],
    }, 1_000),
    result('t1', { time: 1_100 }),
  ])
  const view = snapshot(state, 2_000)
  assert.equal(view.planSource, 'model')
  assert.deepEqual(view.plan.map(step => step.title), ['读一遍现有实现', '补齐分组逻辑', '跑测试'])
  assert.deepEqual(view.plan.map(step => step.status), ['done', 'doing', 'todo'])
})

test('without a model plan, the plan is read off the actions and marked as inferred', () => {
  const state = folded([
    call('c1', 'read', { file_path: 'C:/w/a.js' }, 1_000),
    result('c1', { time: 1_100 }),
    call('c2', 'edit', { file_path: 'C:/w/a.js' }, 2_000),
    result('c2', { time: 2_100 }),
  ])
  const view = snapshot(state, 3_000)
  assert.equal(view.planSource, 'inferred')
  assert.deepEqual(view.plan.map(step => step.title), ['摸清现状', '动手改'])
  // While the turn is still open the last purpose is the one in flight; once
  // the turn closes it is history.
  assert.equal(view.plan.at(-1).status, 'doing')
  const closed = reduce(state, { type: 'turn/end', seq: 9, time: 4_000, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(snapshot(closed, 5_000).plan.at(-1).status, 'done')
})

test('the card exposes purposes with their own commands underneath', () => {
  const state = folded([
    call('c1', 'read', { file_path: 'C:/w/a.js' }, 1_000),
    result('c1', { time: 1_100 }),
    call('c2', 'read', { file_path: 'C:/w/b.js' }, 1_200),
    result('c2', { time: 1_300 }),
  ])
  const view = snapshot(state, 2_000)
  assert.equal(view.episodes.length, 1)
  assert.equal(view.episodes[0].label, '摸清现状')
  assert.match(view.episodes[0].detail, /2 个文件/)
  assert.deepEqual(view.episodes[0].items.map(item => item.detail), ['a.js', 'b.js'])
})

test('the card carries the path: landings, the current focus, and where it got stuck', () => {
  const state = folded([
    call('c1', 'bash', { command: 'pnpm test' }, 1_000),
    result('c1', { isError: true, time: 1_500 }),
    call('c2', 'bash', { command: 'pnpm test' }, 2_000),
    result('c2', { isError: true, time: 2_500 }),
    call('c3', 'edit', { file_path: 'C:/w/vitest.config.ts' }, 3_000),
    result('c3', { time: 3_500 }),
  ])
  const view = snapshot(state, 4_000)
  // A red check is a landing too: "tests are failing" is a state you could
  // stop at, and pretending otherwise would hide where the work stands.
  assert.deepEqual(view.milestones.map(milestone => milestone.kind), ['check', 'change'])
  assert.equal(view.focus.label, '改动了代码')
  assert.equal(view.forks.length, 1)
  assert.equal(view.forks[0].status, 'abandoned')
  assert.equal(view.forks[0].ago, 1_500)
})

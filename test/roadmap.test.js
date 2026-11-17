import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRoadmap, MAX_MILESTONES, MAX_FORKS } from '../plugin/core/roadmap.js'

/** One finished activity entry. */
function act(tool, detail, { at = 1_000, status = 'ok', intent } = {}) {
  return { id: `${tool}-${at}-${detail}`, at, tool, label: tool, detail, intent, status, ms: 10 }
}

test('a passing check is a milestone with its command', () => {
  const { milestones } = buildRoadmap([act('bash', 'pnpm test', { intent: 'verify' })])
  assert.equal(milestones.length, 1)
  assert.equal(milestones[0].kind, 'check')
  assert.equal(milestones[0].label, '验证通过')
  assert.match(milestones[0].detail, /pnpm test/)
})

test('a failing check is a milestone too, and it is not merged with a pass', () => {
  const { milestones } = buildRoadmap([
    act('bash', 'pnpm test', { at: 1_000, status: 'error', intent: 'verify' }),
    act('bash', 'pnpm test', { at: 2_000, intent: 'verify' }),
  ])
  assert.deepEqual(milestones.map(m => m.label), ['验证失败', '验证通过'])
})

test('writing new files is a landing point; editing only is a smaller one', () => {
  const created = buildRoadmap([act('write', 'a.md', { intent: 'modify' })]).milestones[0]
  assert.equal(created.kind, 'create')
  assert.match(created.detail, /a\.md/)
  const changed = buildRoadmap([act('edit', 'a.js', { intent: 'modify' })]).milestones[0]
  assert.equal(changed.kind, 'change')
  assert.match(changed.detail, /a\.js/)
})

test('consecutive landings of the same kind collapse into one node', () => {
  const { milestones } = buildRoadmap([
    act('edit', 'a.js', { at: 1_000, intent: 'modify' }),
    act('edit', 'b.js', { at: 2_000, intent: 'modify' }),
    act('edit', 'c.js', { at: 3_000, intent: 'modify' }),
  ])
  assert.equal(milestones.length, 1)
  assert.equal(milestones[0].count, 3)
  assert.match(milestones[0].detail, /3 个文件/)
})

test('a check breaks the run, so the path keeps its shape', () => {
  const { milestones } = buildRoadmap([
    act('edit', 'a.js', { at: 1_000, intent: 'modify' }),
    act('bash', 'pnpm test', { at: 2_000, intent: 'verify' }),
    act('edit', 'b.js', { at: 3_000, intent: 'modify' }),
  ])
  assert.deepEqual(milestones.map(m => m.kind), ['change', 'check', 'change'])
})

test('a shell command that is not a check only counts when it commits', () => {
  assert.equal(buildRoadmap([act('bash', 'ls -la', { intent: 'execute' })]).milestones.length, 0)
  const committed = buildRoadmap([act('bash', 'git commit -m "x"', { intent: 'execute' })]).milestones
  assert.equal(committed.length, 1)
  assert.equal(committed[0].kind, 'commit')
})

test('a delegation that returned is a landing point', () => {
  const { milestones } = buildRoadmap([act('subagent', '调研 A', { intent: 'delegate' })])
  assert.equal(milestones[0].kind, 'delegate')
  assert.match(milestones[0].detail, /调研 A/)
})

test('two failures on the same target is a fork, and it stays open while it repeats', () => {
  const { forks } = buildRoadmap([
    act('bash', 'pnpm test', { at: 1_000, status: 'error', intent: 'verify' }),
    act('bash', 'pnpm test', { at: 2_000, status: 'error', intent: 'verify' }),
  ])
  assert.equal(forks.length, 1)
  assert.equal(forks[0].status, 'ongoing')
  assert.match(forks[0].detail, /pnpm test/)
  assert.match(forks[0].detail, /2/)
})

test('a different approach after the failures marks the fork as abandoned', () => {
  const { forks } = buildRoadmap([
    act('bash', 'pnpm test', { at: 1_000, status: 'error', intent: 'verify' }),
    act('bash', 'pnpm test', { at: 2_000, status: 'error', intent: 'verify' }),
    act('edit', 'vitest.config.ts', { at: 3_000, intent: 'modify' }),
  ])
  assert.equal(forks.length, 1)
  assert.equal(forks[0].status, 'abandoned')
  assert.match(forks[0].detail, /换/)
})

test('one failure is not a fork', () => {
  const { forks } = buildRoadmap([act('bash', 'pnpm test', { at: 1_000, status: 'error', intent: 'verify' })])
  assert.equal(forks.length, 0)
})

test('the roadmap is capped so a long session stays readable', () => {
  const entries = []
  for (let index = 0; index < 40; index += 1) {
    entries.push(act('bash', `pnpm test #${index}`, { at: index * 1_000 + 1_000, intent: 'verify' }))
    entries.push(act('edit', `f${index}.js`, { at: index * 1_000 + 1_500, intent: 'modify' }))
  }
  const { milestones } = buildRoadmap(entries)
  assert.equal(milestones.length, MAX_MILESTONES)
  assert.equal(milestones.at(-1).kind, 'change')
})

test('forks are capped too', () => {
  const entries = []
  for (let index = 0; index < 20; index += 1) {
    const at = index * 10_000 + 1_000
    entries.push(act('bash', `cmd${index}`, { at, status: 'error', intent: 'execute' }))
    entries.push(act('bash', `cmd${index}`, { at: at + 1_000, status: 'error', intent: 'execute' }))
    entries.push(act('bash', `next${index}`, { at: at + 2_000, intent: 'execute' }))
  }
  const { forks } = buildRoadmap(entries)
  assert.equal(forks.length, MAX_FORKS)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyIntent,
  groupEpisodes,
  describeEpisode,
  deriveStages,
  GAP_MS,
} from '../plugin/core/episodes.js'

/** One finished activity entry, the shape the monitor keeps. */
function act(tool, detail, { at = 1_000, status = 'ok', label = tool } = {}) {
  return { id: `${tool}-${at}-${detail}`, at, tool, label, detail, status, ms: 10 }
}

const read = (detail, at) => act('read', detail, { at })
const grep = (detail, at) => act('grep', detail, { at })
const edit = (detail, at) => act('edit', detail, { at })
const write = (detail, at) => act('write', detail, { at })
const bash = (detail, at, status = 'ok') => act('bash', detail, { at, status, label: '运行命令' })

test('tools fall into intent classes', () => {
  assert.equal(classifyIntent('read', {}), 'investigate')
  assert.equal(classifyIntent('grep', {}), 'investigate')
  assert.equal(classifyIntent('glob', {}), 'investigate')
  assert.equal(classifyIntent('edit', {}), 'modify')
  assert.equal(classifyIntent('write', {}), 'modify')
  assert.equal(classifyIntent('todo_write', {}), 'plan')
  assert.equal(classifyIntent('subagent', {}), 'delegate')
  assert.equal(classifyIntent('present', {}), 'deliver')
  assert.equal(classifyIntent('mystery', {}), 'other')
})

test('a shell command that runs tests or builds is verification, not plain execution', () => {
  assert.equal(classifyIntent('bash', { command: 'pnpm test' }), 'verify')
  assert.equal(classifyIntent('bash', { command: 'npm run build' }), 'verify')
  assert.equal(classifyIntent('bash', { command: 'tsc --noEmit' }), 'verify')
  assert.equal(classifyIntent('bash', { command: 'ls -la' }), 'execute')
  assert.equal(classifyIntent('pwsh', { command: 'git status' }), 'execute')
})

test('consecutive tools of one intent become one episode', () => {
  const episodes = groupEpisodes([read('a.js', 1_000), grep('TODO', 2_000), read('b.js', 3_000)])
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].kind, 'investigate')
  assert.equal(episodes[0].items.length, 3)
})

test('a change of intent starts a new episode', () => {
  const episodes = groupEpisodes([read('a.js', 1_000), edit('a.js', 2_000)])
  assert.equal(episodes.length, 2)
  assert.deepEqual(episodes.map(episode => episode.kind), ['investigate', 'modify'])
})

test('a long pause splits one intent into two episodes', () => {
  const episodes = groupEpisodes([read('a.js', 1_000), read('b.js', 1_000 + GAP_MS + 1)])
  assert.equal(episodes.length, 2)
})

test('an investigation episode says how much was looked at', () => {
  const episode = groupEpisodes([read('a.js', 1_000), read('b.js', 1_100), grep('TODO', 1_200)])[0]
  const described = describeEpisode(episode)
  assert.equal(described.label, '摸清现状')
  assert.match(described.detail, /2 个文件/)
  assert.match(described.detail, /1 次搜索/)
})

test('a modification episode names the files it touched', () => {
  const episode = groupEpisodes([edit('a.js', 1_000), write('b.md', 1_100)])[0]
  const described = describeEpisode(episode)
  assert.equal(described.label, '动手改')
  assert.match(described.detail, /a\.js/)
  assert.match(described.detail, /b\.md/)
})

test('a verification episode reports its outcome', () => {
  const passed = describeEpisode(groupEpisodes([bash('pnpm test', 1_000)])[0])
  assert.equal(passed.label, '跑验证')
  assert.match(passed.detail, /通过/)
  const failed = describeEpisode(groupEpisodes([bash('pnpm test', 1_000, 'error')])[0])
  assert.match(failed.detail, /失败/)
})

test('stages fold several episodes into the few steps a reader can hold', () => {
  const episodes = groupEpisodes([
    read('a.js', 1_000), read('b.js', 1_100),
    edit('a.js', 2_000), edit('b.js', 2_100),
    bash('pnpm test', 3_000),
  ])
  const stages = deriveStages(episodes, { running: false })
  assert.deepEqual(stages.map(stage => stage.label), ['摸清现状', '动手改', '跑验证'])
  assert.equal(stages[0].status, 'done')
  assert.equal(stages[2].status, 'done')
})

test('the last stage is marked as the one in progress while the session runs', () => {
  const episodes = groupEpisodes([read('a.js', 1_000), edit('a.js', 2_000)])
  const stages = deriveStages(episodes, { running: true })
  assert.equal(stages.at(-1).status, 'doing')
  assert.equal(stages[0].status, 'done')
})

test('stages carry the concrete counts, so a reader need not open the commands', () => {
  const episodes = groupEpisodes([read('a.js', 1_000), read('b.js', 1_100), read('c.js', 1_200)])
  const [stage] = deriveStages(episodes, { running: false })
  assert.match(stage.detail, /3 个文件/)
})

/**
 * From commands to purposes.
 *
 * A transcript of `read → read → grep → edit → bash` is exact and useless to a
 * reader: it says what ran, never what it was *for*. This module folds that flat
 * list into episodes ("摸清现状", "动手改", "跑验证") — the few steps a person
 * can hold in their head — while the raw commands stay available underneath.
 *
 * Pure and deterministic: no model call, no clock, no I/O. The same log always
 * yields the same purposes, which is what makes them safe to show.
 */

/** Idle gap past which two runs of the same intent are different episodes. */
export const GAP_MS = 90_000

/** How many purposes a card keeps; older ones roll off. */
export const MAX_STAGES = 6

/** Tools that only look. */
const INVESTIGATE = new Set(['read', 'read_image', 'grep', 'glob', 'file_reference'])
/** Tools that change the workspace. */
const MODIFY = new Set(['edit', 'write', 'apply_patch'])
/** Tools that hand work to another agent. */
const DELEGATE = new Set(['subagent', 'subagent_fork', 'subagent_claude_code', 'subagent_codex', 'workflow'])
/** Tools that record a plan. */
const PLAN = new Set(['todo_write', 'tell_the_diff', 'create_goal', 'update_goal', 'get_goal'])
/** Tools that come back to the human. */
const ASK = new Set(['ask_user_question'])
/** Tools that hand over an artifact. */
const DELIVER = new Set(['present'])

/** Commands whose whole point is checking the work rather than doing it. */
const VERIFY_COMMAND = /(\b(test|tests|build|lint|typecheck|check)\b|vitest|jest|pytest|tsc\b|cargo (test|build|check)|go (test|build|vet)|node --test|pnpm (run )?(test|build|lint)|npm (run )?(test|build|lint)|yarn (test|build))/i

/**
 * What one tool call was *for*, in the coarse vocabulary a reader can act on.
 * @param name - the tool's wire name.
 * @param args - its parsed arguments.
 * @returns the intent class.
 */
export function classifyIntent(name, args = {}) {
  if (INVESTIGATE.has(name)) return 'investigate'
  if (MODIFY.has(name)) return 'modify'
  if (DELEGATE.has(name)) return 'delegate'
  if (PLAN.has(name)) return 'plan'
  if (ASK.has(name)) return 'ask'
  if (DELIVER.has(name)) return 'deliver'
  if (name === 'bash' || name === 'pwsh') {
    const command = typeof args.command === 'string' ? args.command : ''
    return VERIFY_COMMAND.test(command) ? 'verify' : 'execute'
  }
  return 'other'
}

/** The distinct file names an episode touched, in first-seen order. */
function fileNames(items) {
  const names = []
  for (const item of items) {
    if (item.detail === '' || names.includes(item.detail)) continue
    names.push(item.detail)
  }
  return names
}

/** Join names for a chip: up to three, then a count. */
function listNames(names, limit = 3) {
  if (names.length <= limit) return names.join('、')
  return `${names.slice(0, limit).join('、')} 等 ${names.length} 个`
}

/**
 * Fold a chronological activity list into episodes of one intent each.
 * @param recent - activities in chronological order.
 * @param options - `gapMs` overrides the idle-gap split.
 * @returns episodes, oldest first.
 */
export function groupEpisodes(recent, options = {}) {
  const gapMs = Number.isFinite(options.gapMs) ? options.gapMs : GAP_MS
  const episodes = []
  for (const item of recent) {
    // An entry recorded by the monitor carries its intent. One that does not
    // (an older state, or a hand-built list) still classifies from the tool,
    // and a shell entry's `detail` is its command.
    const kind = item.intent ?? classifyIntent(item.tool, { command: item.detail })
    const last = episodes.at(-1)
    if (last !== undefined && last.kind === kind && item.at - last.endedAt <= gapMs) {
      last.items.push(item)
      last.endedAt = item.at
      if (item.status === 'error') last.failed += 1
      continue
    }
    episodes.push({
      kind,
      items: [item],
      startedAt: item.at,
      endedAt: item.at,
      failed: item.status === 'error' ? 1 : 0,
    })
  }
  return episodes
}

/**
 * The human phrase for one episode: a purpose plus the one concrete measure a
 * reader needs to judge it.
 * @param episode - one grouped episode.
 * @returns its label and detail.
 */
export function describeEpisode(episode) {
  const items = episode.items
  switch (episode.kind) {
    case 'investigate': {
      const files = fileNames(items.filter(item => item.tool !== 'grep' && item.tool !== 'glob'))
      const searches = items.filter(item => item.tool === 'grep' || item.tool === 'glob').length
      const parts = []
      if (files.length > 0) parts.push(`${files.length} 个文件`)
      if (searches > 0) parts.push(`${searches} 次搜索`)
      if (files.length > 0 && files.length <= 2) parts.push(listNames(files))
      return { label: '摸清现状', detail: parts.length > 0 ? `读了 ${parts.join('、')}` : '先看一眼' }
    }
    case 'modify': {
      const names = fileNames(items)
      return { label: '动手改', detail: names.length === 0 ? '改了文件' : `动了 ${listNames(names)}` }
    }
    case 'verify': {
      const command = items[0]?.detail ?? ''
      const failed = episode.failed > 0
      return { label: '跑验证', detail: `${command} · ${failed ? '失败' : '通过'}` }
    }
    case 'execute':
      return { label: '跑命令', detail: items[0]?.detail ?? '' }
    case 'delegate':
      return { label: '交给子代理', detail: items[0]?.detail ?? '' }
    case 'plan':
      return { label: '更新计划', detail: '' }
    case 'ask':
      return { label: '向你确认', detail: items[0]?.detail ?? '' }
    case 'deliver':
      return { label: '交出结果', detail: items[0]?.detail ?? '' }
    default:
      return { label: items[0]?.label ?? '做了点事', detail: items[0]?.detail ?? '' }
  }
}

/**
 * Fold episodes into the few steps the card shows as a plan when the model
 * declared none. Each episode is one step; only the trailing one is in flight.
 * @param episodes - grouped episodes, oldest first.
 * @param options - `running` marks the last step as the one in progress.
 * @returns up to MAX_STAGES steps, oldest first.
 */
export function deriveStages(episodes, options = {}) {
  const running = options.running === true
  const kept = episodes.slice(Math.max(0, episodes.length - MAX_STAGES))
  return kept.map((episode, index) => {
    const { label, detail } = describeEpisode(episode)
    return {
      kind: episode.kind,
      label,
      detail,
      count: episode.items.length,
      status: running && index === kept.length - 1 ? 'doing' : 'done',
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
    }
  })
}

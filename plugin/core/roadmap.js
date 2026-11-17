/**
 * The session's path: the few landings that actually changed where the work
 * stands, plus the places it got stuck and had to change approach.
 *
 * A milestone is not "something happened" — it is a point you could stop at and
 * the work would still be in a describable state: a check turned green, files
 * landed, a delegation came back, a commit exists. Everything between two
 * milestones is execution detail, and belongs to the transcript.
 *
 * Pure: same activity list in, same path out.
 */
import { classifyIntent } from './episodes.js'

/** How many landings the path keeps. */
export const MAX_MILESTONES = 12
/** How many stuck points it keeps. */
export const MAX_FORKS = 8
/** Failures on one target before it counts as being stuck. */
export const STUCK_AFTER = 2

/** Shell commands that leave a durable trace worth naming. */
const COMMIT_COMMAND = /\bgit commit\b|\bgit tag\b|\bpnpm add\b|\bnpm (i|install)\b|\bpip install\b|\bcargo add\b/

/** The intent of one entry, recorded or re-derived. */
function intentOf(entry) {
  return entry.intent ?? classifyIntent(entry.tool, { command: entry.detail })
}

/** File names a run of entries touched, first-seen order. */
function namesOf(entries) {
  const names = []
  for (const entry of entries) {
    if (entry.detail === '' || names.includes(entry.detail)) continue
    names.push(entry.detail)
  }
  return names
}

/** "a.js" / "3 个文件" — one name is information, twenty is noise. */
function namesDetail(names) {
  if (names.length === 1) return names[0]
  return `${names.length} 个文件`
}

/** The milestone one entry could contribute, or null. */
function candidateOf(entry) {
  const intent = intentOf(entry)
  if (intent === 'verify') {
    return { key: `check:${entry.status === 'error' ? 'fail' : 'pass'}`, kind: 'check', entry }
  }
  if (intent === 'modify') {
    return { key: entry.tool === 'write' ? 'create' : 'change', kind: entry.tool === 'write' ? 'create' : 'change', entry }
  }
  if (intent === 'delegate') return { key: 'delegate', kind: 'delegate', entry }
  if (intent === 'execute' && entry.status !== 'error' && COMMIT_COMMAND.test(entry.detail)) {
    return { key: 'commit', kind: 'commit', entry }
  }
  return null
}

/** The label for one milestone kind. */
function labelOf(kind, entries) {
  switch (kind) {
    case 'check':
      return entries[0].status === 'error' ? '验证失败' : '验证通过'
    case 'create':
      return '新建了文件'
    case 'change':
      return '改动了代码'
    case 'delegate':
      return '子代理交回结果'
    case 'commit':
      return '提交了一次'
    default:
      return '有个变化'
  }
}

/** The detail line for one milestone. */
function detailOf(kind, entries) {
  switch (kind) {
    case 'check':
      return entries[0].detail
    case 'create':
    case 'change':
      return namesDetail(namesOf(entries))
    default:
      return entries[0].detail
  }
}

/** When the action actually settled — a landing happens at the end, not the start. */
function endOf(entry) {
  return Number.isFinite(entry.ms) ? entry.at + entry.ms : entry.at
}

/** The landings, coalescing consecutive ones of the same kind. */
function milestonesOf(recent) {
  const milestones = []
  for (const entry of recent) {
    const candidate = candidateOf(entry)
    if (candidate === null) continue
    const last = milestones.at(-1)
    if (last !== undefined && last.key === candidate.key) {
      last.entries.push(entry)
      last.at = endOf(entry)
      continue
    }
    milestones.push({ key: candidate.key, kind: candidate.kind, at: endOf(entry), entries: [entry] })
  }
  const shaped = milestones.map(milestone => ({
    id: `${milestone.kind}-${milestone.at}`,
    kind: milestone.kind,
    at: milestone.at,
    label: labelOf(milestone.kind, milestone.entries),
    detail: detailOf(milestone.kind, milestone.entries),
    count: milestone.entries.length,
    failed: milestone.kind === 'check' && milestone.entries[0].status === 'error',
  }))
  return shaped.slice(Math.max(0, shaped.length - MAX_MILESTONES))
}

/** The stable identity of "what was being attempted". */
function targetOf(entry) {
  return `${entry.tool}:${entry.detail}`
}

/**
 * Places where the same target failed repeatedly. Whether it was truly
 * abandoned is a claim, so the status says so: `ongoing` while the failures are
 * the last thing that happened, `abandoned` only once a different approach
 * followed.
 */
function forksOf(recent) {
  const forks = []
  let run = null
  for (const entry of recent) {
    const target = targetOf(entry)
    if (run === null || run.target !== target) {
      finish(run, forks)
      run = { target, detail: entry.detail, failures: 0, at: endOf(entry) }
    }
    if (entry.status === 'error') {
      run.failures += 1
      run.at = endOf(entry)
    }
  }
  finish(run, forks)
  return forks.slice(Math.max(0, forks.length - MAX_FORKS))

  function finish(current, into) {
    if (current === null || current.failures < STUCK_AFTER) return
    into.push(current)
  }
}

/**
 * The whole path for one session's activity.
 * @param recent - activities in chronological order.
 * @returns milestones (oldest first) and forks.
 */
export function buildRoadmap(recent) {
  const milestones = milestonesOf(recent)
  const forks = forksOf(recent).map(fork => {
    const followUps = recent.filter(entry => entry.at > fork.at)
    const movedOn = followUps.some(entry => targetOf(entry) !== fork.target)
    const target = fork.detail === '' ? '这一步' : `「${fork.detail}」`
    return {
      id: `fork-${fork.at}`,
      at: fork.at,
      target: fork.target,
      failures: fork.failures,
      status: movedOn ? 'abandoned' : 'ongoing',
      detail: movedOn
        ? `${target}试了 ${fork.failures} 次没通，换了做法`
        : `${target}试了 ${fork.failures} 次没通`,
    }
  })
  return { milestones, forks }
}

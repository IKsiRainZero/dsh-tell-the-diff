/**
 * The deterministic half of TellTheDiff: session events in, a plain-language
 * status card out.
 *
 * Nothing here calls a model, reads a clock it was not given, or mutates its
 * input — `reduce(state, event)` is a pure fold over one session's durable log
 * and returns the same reference for events it does not care about. That buys
 * three things the plugin needs: replayability (the log is the source of
 * truth), cheap storage (an unchanged state costs nothing downstream), and
 * unit tests that need no Harness at all.
 */

import { classifyIntent, groupEpisodes, deriveStages, describeEpisode } from './episodes.js'

/** How many finished activities the card keeps. */
export const MAX_RECENT = 20
/** How many unresolved/resolved issues the card keeps. */
export const MAX_ISSUES = 10
/** How many checkpoints the model may push; only the newest one is shown. */
export const MAX_CHECKPOINTS = 5
/** A step running longer than this is worth a card, not just a quiet update. */
export const LONG_RUN_MS = 90_000
/** Two failures inside this window are a pattern, not an accident. */
export const FAILURE_WINDOW_MS = 120_000
/** Failures inside the window that make it a pattern. */
export const FAILURE_COUNT = 2
/** Bumped when the fold semantics change, so stored state is discarded. */
export const STATE_VERSION = 2

/**
 * Tool name → what a non-technical reader would call that action.
 * Every entry is a verb phrase the panel can put after "正在".
 */
const TOOL_LANGUAGE = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  glob: '查找文件',
  grep: '搜索内容',
  bash: '运行命令',
  pwsh: '运行命令',
  web_search: '联网搜索',
  web_fetch: '打开网页',
  subagent: '交给子代理',
  subagent_fork: '交给子代理',
  subagent_claude_code: '交给子代理',
  subagent_codex: '交给子代理',
  workflow: '跑批量流程',
  todo_write: '更新待办',
  ask_user_question: '向你提问',
  present: '交付文件',
  skill: '加载技能',
  job_list: '查看后台任务',
  job_output: '查看后台任务',
  job_kill: '停止后台任务',
  create_goal: '设定目标',
  update_goal: '更新目标',
  get_goal: '查看目标',
  send_message: '给子代理发消息',
  wait_agent: '等子代理',
  list_agents: '查看子代理',
  list_subagent_models: '查模型',
  tell_the_diff: '更新状态卡',
  office_render: '渲染文档',
  office_convert: '转换文档',
  office_recalculate: '重算表格',
  read_image: '看图片',
  terminal_open: '开终端',
  terminal_read: '读终端',
}

/** Argument keys worth showing, in priority order. */
const DETAIL_KEYS = ['file_path', 'path', 'pattern', 'query', 'command', 'url', 'description', 'prompt', 'text']

/** Tools that write a file (they change what the user has to re-read). */
const WRITE_TOOLS = new Set(['write'])
/** Tools that modify an existing file. */
const EDIT_TOOLS = new Set(['edit'])
/** Tools that only read. */
const READ_TOOLS = new Set(['read', 'read_image'])

/** The last path segment, for a chip that has to stay short. */
export function basename(path) {
  const normalized = String(path ?? '').replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name === '' ? normalized : name
}

/**
 * A path as short as it can be while still telling two files apart: relative to
 * the session's working directory when it sits inside it, its basename
 * otherwise.
 * @param path - the recorded path.
 * @param cwd - the session's working directory, when the host knows it.
 * @returns the display path.
 */
export function displayPath(path, cwd) {
  const normalized = String(path ?? '').replaceAll('\\', '/')
  if (typeof cwd === 'string' && cwd !== '') {
    const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1)
  }
  return basename(normalized)
}

/** Parse tool arguments that arrive either as a JSON string or an object. */
function argsOf(rawArguments) {
  if (rawArguments !== null && typeof rawArguments === 'object') return rawArguments
  if (typeof rawArguments !== 'string' || rawArguments === '') return {}
  try {
    const parsed = JSON.parse(rawArguments)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Turn one tool call into the pair the card shows: a plain verb phrase and the
 * one concrete thing it touched.
 * @param name - the tool's wire name.
 * @param rawArguments - its arguments, as recorded.
 * @param cwd - the session's working directory, used to shorten file paths.
 * @returns the label plus a short detail (empty when nothing is worth showing).
 */
export function describeTool(name, rawArguments, cwd) {
  const args = argsOf(rawArguments)
  const label = TOOL_LANGUAGE[name] ?? String(name)
  for (const key of DETAIL_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = value.trim()
      if (key === 'file_path' || key === 'path') return { label, detail: displayPath(text, cwd) }
      return { label, detail: text.length > 60 ? `${text.slice(0, 57)}…` : text }
    }
  }
  return { label, detail: '' }
}

/** A fresh, empty monitor state for one session. */
export function createState(sessionId = null, options = {}) {
  return {
    version: STATE_VERSION,
    sessionId,
    cwd: typeof options.cwd === 'string' ? options.cwd : null,
    updatedAt: 0,
    turn: 0,
    running: false,
    lastUserAt: null,
    current: null,
    recent: [],
    files: [],
    issues: [],
    checkpoints: [],
    plan: [],
    planSource: null,
    stats: { toolCalls: 0, errors: 0, turns: 0 },
  }
}

/** Touch a file record for one call, keeping identity by full path. */
function trackFile(files, path, kind, at) {
  const normalized = String(path).replaceAll('\\', '/')
  const found = files.find(file => file.path === normalized)
  if (found === undefined) {
    return [...files, {
      path: normalized,
      name: basename(normalized),
      reads: kind === 'read' ? 1 : 0,
      edits: kind === 'edit' ? 1 : 0,
      writes: kind === 'write' ? 1 : 0,
      lastAt: at,
    }]
  }
  return files.map(file => file.path !== normalized ? file : {
    ...file,
    reads: file.reads + (kind === 'read' ? 1 : 0),
    edits: file.edits + (kind === 'edit' ? 1 : 0),
    writes: file.writes + (kind === 'write' ? 1 : 0),
    lastAt: at,
  })
}

/** Append while keeping the newest `limit` entries. */
function capped(list, entry, limit) {
  const next = [...list, entry]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** Record one open issue for a failed action. */
function openIssue(state, event, label, detail, tool) {
  const callId = event.data?.message?.toolCallId ?? `t${event.seq}`
  const issue = {
    id: String(callId),
    at: event.time,
    label,
    detail,
    tool: tool ?? null,
    resolvedAt: null,
  }
  return {
    ...state,
    issues: capped(state.issues, issue, MAX_ISSUES),
    stats: { ...state.stats, errors: state.stats.errors + 1 },
  }
}

/**
 * Fold one durable session event into the monitor state.
 * @param state - the current state; never mutated.
 * @param event - one `SessionEvent` as recorded.
 * @returns the next state, or the same reference when the event is irrelevant.
 */
export function reduce(state, event) {
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'turn/start':
      return {
        ...state,
        running: true,
        turn: data.turn ?? state.turn,
        current: null,
        updatedAt: event.time,
        stats: { ...state.stats, turns: state.stats.turns + 1 },
      }

    case 'turn/end': {
      const ended = { ...state, running: false, current: null, updatedAt: event.time }
      return data.reason?.kind === 'error'
        ? openIssue(ended, event, '这一轮出错', String(data.reason?.error?.message ?? '').slice(0, 120), null)
        : ended
    }

    case 'user/message':
      return { ...state, lastUserAt: event.time, updatedAt: event.time }

    case 'assistant/message':
      return state.running ? { ...state, updatedAt: event.time } : { ...state, updatedAt: event.time }

    case 'tool/call': {
      const args = argsOf(data.arguments)
      const { label, detail } = describeTool(data.name, data.arguments, state.cwd)
      const entry = {
        id: String(data.callId),
        at: event.time,
        tool: data.name,
        label,
        detail,
        intent: classifyIntent(data.name, args),
        status: 'running',
        ms: null,
      }
      let next = {
        ...state,
        running: true,
        current: { id: entry.id, tool: data.name, label, detail, startedAt: event.time },
        recent: capped(state.recent, entry, MAX_RECENT),
        updatedAt: event.time,
        stats: { ...state.stats, toolCalls: state.stats.toolCalls + 1 },
      }
      // The model's own plan is the best plan there is; take it whenever the
      // model records one, and never ask it to record one just for this card.
      if (data.name === 'todo_write' && Array.isArray(args.todos)) {
        const plan = planFromTodos(args.todos)
        if (plan !== null) next = { ...next, plan, planSource: 'model', updatedAt: event.time }
      }
      const path = typeof args.file_path === 'string' ? args.file_path : args.path
      const kind = WRITE_TOOLS.has(data.name) ? 'write' : EDIT_TOOLS.has(data.name) ? 'edit' : READ_TOOLS.has(data.name) ? 'read' : null
      if (kind !== null && typeof path === 'string' && path !== '') next = { ...next, files: trackFile(next.files, path, kind, event.time) }
      return next
    }

    case 'tool/result': {
      const callId = String(data.message?.toolCallId ?? '')
      const at = state.recent.find(entry => entry.id === callId)
      if (at === undefined) return state
      const status = data.message?.isError === true ? 'error' : 'ok'
      const finished = { ...at, status, ms: event.time - at.at }
      let next = {
        ...state,
        recent: state.recent.map(entry => entry.id === callId ? finished : entry),
        current: state.current?.id === callId ? null : state.current,
        updatedAt: event.time,
      }
      if (status === 'error') return openIssue(next, event, finished.label, finished.detail, finished.tool)
      // A success on the same tool closes the issues that tool opened.
      return {
        ...next,
        issues: next.issues.map(issue =>
          issue.resolvedAt === null && issue.tool === finished.tool ? { ...issue, resolvedAt: event.time } : issue),
      }
    }

    default:
      return state
  }
}

/**
 * The model's own todo list, mapped onto the card's step vocabulary. This is
 * the highest-authority plan source: it is what the model already told the
 * session it intends to do.
 * @param todos - `todo_write`'s `todos` argument.
 * @returns steps, or null when the list is empty.
 */
export function planFromTodos(todos) {
  const steps = todos
    .filter(todo => todo !== null && typeof todo === 'object' && typeof todo.content === 'string')
    .slice(0, 12)
    .map(todo => ({
      title: todo.content,
      status: todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'doing' : 'todo',
    }))
  return steps.length === 0 ? null : steps
}

/**
 * Record the model's own plain-language checkpoint. This is the only channel by
 * which the card can say *why*, not just *what*.
 * @param state - the current state.
 * @param checkpoint - the model's description of where the task stands.
 * @param now - the clock reading to stamp it with.
 * @returns the next state.
 */
export function noteCheckpoint(state, checkpoint, now) {
  const entry = {
    at: now,
    plain: String(checkpoint?.plain ?? '').trim(),
    steps: Array.isArray(checkpoint?.steps)
      ? checkpoint.steps
        .filter(step => step !== null && typeof step === 'object' && typeof step.title === 'string')
        .slice(0, 12)
        .map(step => ({ title: step.title, status: ['todo', 'doing', 'done', 'blocked'].includes(step.status) ? step.status : 'todo' }))
      : [],
    questions: Array.isArray(checkpoint?.questions) ? checkpoint.questions.filter(question => typeof question === 'string').slice(0, 5) : [],
    risks: Array.isArray(checkpoint?.risks) ? checkpoint.risks.filter(risk => typeof risk === 'string').slice(0, 5) : [],
  }
  return {
    ...state,
    checkpoints: capped(state.checkpoints, entry, MAX_CHECKPOINTS),
    ...(entry.steps.length > 0 ? { plan: entry.steps, planSource: 'model' } : {}),
    updatedAt: now,
  }
}

/** "7 秒" / "2 分 10 秒" / "刚刚" */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) return '刚刚'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/**
 * The presentation model the side panel renders. Pure: same state and clock,
 * same card.
 * @param state - a folded monitor state.
 * @param now - the current clock reading.
 * @returns the card fields, newest information first.
 */
export function snapshot(state, now) {
  const checkpoint = state.checkpoints.at(-1) ?? null
  const running = state.current
  const idleFor = state.updatedAt > 0 ? now - state.updatedAt : null
  const headline = running !== null
    ? `正在${running.label}${running.detail === '' ? '' : ` · ${running.detail}`}`
    : state.updatedAt > 0
      ? `空闲 · 上一步 ${humanDuration(idleFor)}前结束`
      : '还没开始'
  const episodes = groupEpisodes(state.recent)
  const stages = deriveStages(episodes, { running: state.running || running !== null })
  const hasModelPlan = state.plan.length > 0
  const plan = hasModelPlan
    ? state.plan
    : stages.map(stage => ({ title: stage.label, status: stage.status, detail: stage.detail }))
  return {
    sessionId: state.sessionId,
    running: running !== null,
    turn: state.turn,
    phaseLabel: running !== null ? '进行中' : state.running ? '思考中' : state.updatedAt > 0 ? '等待下一步' : '刚开工',
    headline,
    idleFor,
    plain: checkpoint?.plain ?? '',
    plan,
    // Where the plan came from decides how much to trust it: the model's own
    // words, or our reading of its actions.
    planSource: hasModelPlan ? 'model' : stages.length > 0 ? 'inferred' : null,
    questions: checkpoint?.questions ?? [],
    risks: checkpoint?.risks ?? [],
    episodes: episodes.slice(-3).map(episode => {
      const described = describeEpisode(episode)
      return {
        kind: episode.kind,
        label: described.label,
        detail: described.detail,
        failed: episode.failed,
        count: episode.items.length,
        ago: now - episode.endedAt,
        items: episode.items.slice(-4).map(item => ({
          tool: item.tool,
          label: item.label,
          detail: item.detail,
          status: item.status,
        })),
      }
    }),
    activity: [...state.recent].reverse().map(entry => ({
      id: entry.id,
      tool: entry.tool,
      label: entry.label,
      detail: entry.detail,
      status: entry.status,
      ago: now - entry.at,
      ms: entry.ms,
    })),
    files: [...state.files].sort((left, right) => right.lastAt - left.lastAt).map(file => ({
      path: file.path,
      name: file.name,
      reads: file.reads,
      edits: file.edits,
      writes: file.writes,
      ago: now - file.lastAt,
    })),
    openIssues: state.issues.filter(issue => issue.resolvedAt === null).map(issue => ({
      label: issue.label,
      detail: issue.detail,
      ago: now - issue.at,
    })),
    stats: { ...state.stats },
    budget: { modelCalls: 0, tokens: 0, note: 'α 版不调用模型' },
  }
}

/**
 * The intervention-timing function: how loudly this state deserves to surface.
 * Alpha stops at `card` — it never claims the user's attention and never steers.
 * @param state - a folded monitor state.
 * @param now - the current clock reading.
 * @returns 'silent' (quiet update), 'card' (worth a glance), or 'alert' (reserved).
 */
export function shouldSurface(state, now) {
  if (state.current !== null && now - state.current.startedAt >= LONG_RUN_MS) return 'card'
  const recentFailures = state.issues.filter(issue => now - issue.at <= FAILURE_WINDOW_MS).length
  if (recentFailures >= FAILURE_COUNT) return 'card'
  return 'silent'
}

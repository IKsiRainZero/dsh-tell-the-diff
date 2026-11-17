/**
 * dsh-tell-the-diff — Host half.
 *
 * Owns three things and nothing else:
 *   - the per-session monitor state built from the durable event feed,
 *   - the read-only HTTP route the side panel polls,
 *   - the `tell_the_diff` tool the model uses to say where a task stands in
 *     plain language.
 *
 * No model is called. No token is spent. The panel is a faithful, lossy-in-the-
 * right-places rendering of what the session log already recorded.
 */
import { createMonitorStore } from './core/store.js'

export const name = 'dsh-tell-the-diff'
export const inject = ['webServer', 'tools', 'sessions']

/** Route prefix; the client half hardcodes the same string. */
const ROUTE = '/dsh-tell-the-diff'

/** The tool's schema: deliberately small, so its context cost stays bounded. */
const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['plain'],
  properties: {
    plain: {
      type: 'string',
      description: '一句话说清现在到哪了，写给完全不懂技术的人看。说"在做什么、还差什么"，不要用比喻、黑话或代码术语。',
    },
    steps: {
      type: 'array',
      description: '这件任务被拆成了几步，以及每一步的状态。新任务或阶段变化时给出。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'status'],
        properties: {
          title: { type: 'string', description: '一步做什么，用动词开头的人话。' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
        },
      },
    },
    questions: {
      type: 'array',
      description: '需要用户拍板或提供信息的问题；没有就给空数组。',
      items: { type: 'string' },
    },
    risks: {
      type: 'array',
      description: '用户应该提前知道的风险或代价；没有就给空数组。',
      items: { type: 'string' },
    },
  },
}

/** What the tool returns to the model. */
const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'sessionId'],
    properties: {
      ok: { type: 'boolean' },
      sessionId: { type: 'string' },
      plain: { type: 'string' },
      steps: { type: 'number' },
    },
  },
  render(args, value) {
    if (value?.ok !== true) return [{ type: 'text', text: '状态卡没更新成功，请继续任务，之后可以再试一次。' }]
    const steps = Number(value.steps ?? 0)
    return [{
      type: 'text',
      text: `状态卡已更新（${steps} 步计划）：${String(value.plain ?? '')}`,
    }]
  },
}

/** Answer with JSON and no caching. */
function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** How much of an existing session's log the first read rebuilds from. */
const SEED_EVENTS = 400

/**
 * Build a card for a session this instance has never seen — after a restart, or
 * for a session that was already running when the bundle loaded. Without it the
 * card would claim "还没开始" over a full log.
 * @returns the view, or undefined when the session is not live.
 */
function seedFromLog(ctx, store, sessionId) {
  const session = ctx.sessions?.get?.(sessionId)
  if (session === undefined) return undefined
  const end = Number(session.seq ?? 0)
  const start = Math.max(0, end - SEED_EVENTS)
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(start, end) : []
  return store.seed(sessionId, session.header?.cwd, events)
}

/**
 * Host plugin body.
 * @param ctx - the Cordis context owning this plugin.
 */
export function apply(ctx) {
  const store = createMonitorStore()

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    store.observe(session, event)
  }), 'tell-the-diff: event feed')

  ctx.effect(() => ctx.on('session/disposed', (session) => {
    store.forget(session?.id)
  }), 'tell-the-diff: session disposal')

  ctx.effect(() => {
    const handle = setInterval(() => store.prune(), 60_000)
    handle.unref?.()
    return () => clearInterval(handle)
  }, 'tell-the-diff: retention sweep')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('session')
      if (sessionId === null || sessionId === '') return json(res, 400, { ok: false, error: 'session is required' })
      const view = store.view(sessionId) ?? seedFromLog(ctx, store, sessionId)
      if (view === undefined) return json(res, 200, { ok: true, known: false })
      return json(res, 200, { ok: true, known: true, view })
    },
  }), 'tell-the-diff: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/list`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      return json(res, 200, { ok: true, sessions: store.list().map(view => ({
        sessionId: view.sessionId,
        running: view.running,
        headline: view.headline,
        turns: view.stats.turns,
      })) })
    },
  }), 'tell-the-diff: list route')

  ctx.effect(() => ctx.tools.register({
    name: 'tell_the_diff',
    description: [
      '把当前任务的进展写成给非技术读者看的人话，更新侧栏「任务状态」卡。',
      '在任务开始、阶段切换、遇到阻塞、或长任务每推进一段之后调用一次；不要每做一步都调。',
      'plain 必须说清：这件事拆成了几步、现在在第几步、卡在哪、接下来做什么。',
      '禁止使用比喻、内部黑话、文件名清单或代码术语——用户要的是能看懂的现状，不是日志。',
      '这个工具不打断任务、不改变执行路径，只更新一个只读面板。',
    ].join(''),
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.id ?? '')
      if (sessionId === '') return { ok: false, sessionId, plain: '', steps: 0 }
      const view = store.checkpoint(sessionId, args ?? {})
      return {
        ok: true,
        sessionId,
        plain: view?.plain ?? '',
        steps: Array.isArray(view?.plan) ? view.plan.length : 0,
      }
    },
  }), 'tell-the-diff: tool')
}

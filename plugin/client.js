/**
 * dsh-tell-the-diff — Browser half.
 *
 * One read-only card in the right sidebar: what this session is doing right
 * now, in words a non-technical reader can act on. It polls the Host half's
 * read-only route and never sends anything but a GET.
 *
 * The tab is registered through the public two-stage path (the type into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab`
 * seat), so it works with or without any other sidebar plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tell-the-diff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Host route prefix; must match `plugin/index.js`. */
    const ROUTE = '/dsh-tell-the-diff'
    /** This implementation's identity in the tab system. */
    const ID = 'dsh-tell-the-diff'
    /** The page kind the guide entry opens. */
    const KIND = 'tell-the-diff'
    /** Poll cadence while the tab is on screen. */
    const POLL_MS = 1500

    const TEXT = {
      zh: {
        tabTitle: '任务状态',
        tabDescription: '用普通人能看懂的话说明这个会话在做什么、做到哪、卡在哪。',
        heading: '任务状态',
        empty: '这个会话还没有开始。任务一开始，这里就会显示它在做什么。',
        unknownSession: '还没有可显示的状态。发一句话给模型，这里就会亮起来。',
        plan: '这件事拆成了几步',
        questions: '需要你决定',
        risks: '可能的风险',
        activity: '最近做了什么',
        files: '动过的文件',
        stats: (tools, errors) => `${tools} 次动作 · ${errors} 次出错`,
        budget: '模型调用 0 次（α 版只读会话记录，不额外消耗 token）',
        failed: '读取状态失败',
        noFiles: '还没动过文件',
        noActivity: '还没有工具动作',
        statusRunning: '进行中',
        statusIdle: '空闲',
        stepTodo: '还没开始',
        stepDoing: '正在做',
        stepDone: '已完成',
        stepBlocked: '卡住了',
      },
      en: {
        tabTitle: 'Task status',
        tabDescription: 'What this session is doing, and where it stands, in plain words.',
        heading: 'Task status',
        empty: 'Nothing has happened in this session yet. The card fills in once a task starts.',
        unknownSession: 'No status to show yet. Send one message and this card lights up.',
        plan: 'Broken into steps',
        questions: 'Needs your decision',
        risks: 'Risks to know',
        activity: 'What just happened',
        files: 'Files touched',
        stats: (tools, errors) => `${tools} actions · ${errors} errors`,
        budget: '0 model calls — alpha reads the session log only',
        failed: 'Could not read status',
        noFiles: 'No files touched yet',
        noActivity: 'No tool actions yet',
        statusRunning: 'Running',
        statusIdle: 'Idle',
        stepTodo: 'Not started',
        stepDoing: 'In progress',
        stepDone: 'Done',
        stepBlocked: 'Blocked',
      },
    }

    /** The dictionary for the browser's current language. */
    function dictionary() {
      const language = String(globalThis.navigator?.language ?? 'zh').toLowerCase()
      return language.startsWith('zh') ? TEXT.zh : TEXT.en
    }

    /** "12 秒前" / "3 分前" — coarse on purpose, this is a glance, not a stopwatch. */
    function humanAgo(ms, t) {
      const seconds = Math.max(0, Math.round(Number(ms ?? 0) / 1000))
      if (seconds < 60) return `${seconds} 秒前`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分前`
      return `${Math.round(minutes / 60)} 小时前`
    }

    const STATUS_COLOR = {
      running: 'var(--dsw-alias-state-idle-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const chip = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '1px 7px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l1)',
      fontSize: 11,
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
    }

    const sectionTitle = {
      margin: '16px 0 6px',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '.04em',
      color: 'var(--dsw-alias-label-secondary)',
    }

    /** One plan row: a status glyph plus the step's plain-language title. */
    function StepRow({ step, t }) {
      const glyph = step.status === 'done' ? '✓' : step.status === 'doing' ? '●' : step.status === 'blocked' ? '!' : '○'
      const color = step.status === 'done'
        ? 'var(--dsw-alias-state-success-primary)'
        : step.status === 'doing'
          ? 'var(--dsw-alias-brand-primary)'
          : step.status === 'blocked'
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-state-idle-primary)'
      const label = { todo: t.stepTodo, doing: t.stepDoing, done: t.stepDone, blocked: t.stepBlocked }[step.status] ?? t.stepTodo
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0' } },
        h('span', { 'aria-hidden': true, style: { color, fontSize: 12, lineHeight: '18px', width: 12, flex: '0 0 12px' } }, glyph),
        h('span', {
          title: label,
          style: {
            fontSize: 12.5,
            lineHeight: '18px',
            color: step.status === 'todo' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
            textDecoration: step.status === 'done' ? 'line-through' : 'none',
            opacity: step.status === 'done' ? 0.65 : 1,
          },
        }, step.title),
      )
    }

    /** One activity row: what the model did, how it ended, how long it took. */
    function ActivityRow({ entry, t }) {
      const color = STATUS_COLOR[entry.status] ?? STATUS_COLOR.running
      return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0' } },
        h('span', { 'aria-hidden': true, style: { color, fontSize: 9, flex: '0 0 8px' } }, '●'),
        h('span', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', minWidth: 0 } },
          entry.label,
          entry.detail === '' ? null : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, ` · ${entry.detail}`),
        ),
        h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
          entry.status === 'running' ? t.statusRunning : humanAgo(entry.ago, t)),
      )
    }

    /**
     * The card. Fetches one session's status on a timer while it is mounted.
     * @param props - `sessionId` injected by the slot; `visible` when docked.
     */
    function StatusCard(props) {
      const t = dictionary()
      const sessionId = props.sessionId
        ?? props.scope?.sessionId
        ?? props.session?.sessionId
        ?? props.tab?.sessionId
        ?? null
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async (signal) => {
        if (sessionId === null || sessionId === '') return
        try {
          const response = await fetch(`${ROUTE}/state?session=${encodeURIComponent(sessionId)}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal,
          })
          const payload = await response.json()
          if (!response.ok || payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
          setView(payload.known === true ? payload.view : null)
          setError(null)
        } catch (failure) {
          if (failure?.name === 'AbortError') return
          setError(String(failure?.message ?? failure))
        }
      }, [sessionId])

      useEffect(() => {
        if (sessionId === null || sessionId === '') return undefined
        const controller = new AbortController()
        load(controller.signal)
        const handle = setInterval(() => load(controller.signal), POLL_MS)
        return () => {
          clearInterval(handle)
          controller.abort()
        }
      }, [load, sessionId])

      if (sessionId === null || sessionId === '') {
        return h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t.unknownSession)
      }

      return h('div', { style: { padding: '12px 14px 20px', display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, letterSpacing: '.02em', color: 'var(--dsw-alias-label-secondary)' } }, t.heading),
          view === null ? null : h('span', { style: { ...chip, color: view.running ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' } }, view.phaseLabel),
          view === null ? null : h('span', { style: { ...chip, marginLeft: 'auto' } }, `第 ${view.turn} 轮`),
        ),

        error !== null
          ? h('div', { style: { marginTop: 10, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, `${t.failed}：${error}`)
          : null,

        view === null
          ? h('div', { style: { marginTop: 14, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' } }, t.empty)
          : h('div', null,
            h('div', { style: { marginTop: 10, fontSize: 14.5, lineHeight: '21px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } }, view.headline),

            view.plain === ''
              ? null
              : h('div', {
                style: {
                  marginTop: 10,
                  padding: '9px 11px',
                  borderLeft: '3px solid var(--dsw-alias-brand-primary)',
                  borderRadius: '0 8px 8px 0',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  fontSize: 13,
                  lineHeight: '20px',
                  color: 'var(--dsw-alias-label-primary)',
                  overflowWrap: 'anywhere',
                },
              }, view.plain),

            view.plan.length === 0 ? null : h('div', null,
              h('div', { style: sectionTitle }, t.plan),
              h('div', null, view.plan.map((step, index) => h(StepRow, { key: `${index}-${step.title}`, step, t }))),
            ),

            view.questions.length === 0 ? null : h('div', null,
              h('div', { style: { ...sectionTitle, color: 'var(--dsw-alias-state-warn-primary)' } }, t.questions),
              h('div', { style: { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-warn-primary)', fontSize: 12.5, lineHeight: '19px' } },
                view.questions.map((question, index) => h('div', { key: index }, question))),
            ),

            view.risks.length === 0 ? null : h('div', null,
              h('div', { style: sectionTitle }, t.risks),
              h('div', { style: { fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' } },
                view.risks.map((risk, index) => h('div', { key: index }, risk))),
            ),

            view.openIssues.length === 0 ? null : h('div', null,
              h('div', { style: { ...sectionTitle, color: 'var(--dsw-alias-state-error-primary)' } }, '还没解决的问题'),
              h('div', { style: { fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-label-primary)' } },
                view.openIssues.map((issue, index) => h('div', { key: index }, `${issue.label}${issue.detail === '' ? '' : ` · ${issue.detail}`}`))),
            ),

            h('div', { style: sectionTitle }, t.activity),
            view.activity.length === 0
              ? h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, t.noActivity)
              : h('div', null, view.activity.slice(0, 8).map(entry => h(ActivityRow, { key: entry.id, entry, t }))),

            h('div', { style: sectionTitle }, t.files),
            view.files.length === 0
              ? h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, t.noFiles)
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, view.files.slice(0, 8).map(file => h('div', {
                key: file.path,
                title: file.path,
                style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
              },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } }, file.name),
              h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
                [file.reads > 0 ? `读 ${file.reads}` : '', file.edits > 0 ? `改 ${file.edits}` : '', file.writes > 0 ? `写 ${file.writes}` : ''].filter(Boolean).join(' · ')),
              ))),

            h('div', { style: { marginTop: 18, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' } },
              h('div', null, t.stats(view.stats.toolCalls, view.stats.errors)),
              h('div', null, t.budget),
            ),
          ),
      )
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: () => dictionary().tabTitle,
          guide: [{
            id: 'status',
            order: 10,
            title: () => dictionary().tabTitle,
            description: () => dictionary().tabDescription,
          }],
        }), 'tell-the-diff: tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          inject: (sessionId) => ({ sessionId }),
        }, StatusCard)), 'tell-the-diff: tab body')

        // `dsh-better-sidebar`, when installed, draws the right column from its
        // OWN tab registry instead of the native one, and renders whatever that
        // registry points at. Without this bridge the card would be an
        // "orphaned tab" there. The service may arrive after this module, so
        // watch for it briefly rather than assuming load order.
        ctx.effect(() => {
          let dispose = null
          let attempts = 0
          const attach = () => {
            if (dispose !== null) return true
            const better = ctx.get?.('betterSidebar') ?? ctx.betterSidebar
            if (better === undefined || typeof better.registerTab !== 'function') return false
            dispose = better.registerTab({
              id: ID,
              title: () => dictionary().tabTitle,
              description: () => dictionary().tabDescription,
              single: true,
              order: 30,
              component: StatusCard,
            })
            return true
          }
          if (attach()) return () => { dispose?.() }
          const handle = setInterval(() => {
            attempts += 1
            if (attach() || attempts > 40) clearInterval(handle)
          }, 250)
          return () => {
            clearInterval(handle)
            dispose?.()
          }
        }, 'tell-the-diff: better-sidebar bridge')
      },
    }
  },
})

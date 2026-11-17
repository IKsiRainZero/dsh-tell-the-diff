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
        tabTitle: '这一路',
        tabDescription: '会话走到哪了：落点、岔路，以及此刻的状态。',
        heading: '这一路',
        roadmap: '落点',
        noRoadmap: '还没有落点。等第一个可验证的结果出现（测试通过、文件落地），这里就会长出第一段路。',
        stuck: '卡住了',
        detour: '换过路',
        filesShort: '文件',
        actionsShort: '动作',
        open: '打开',
        empty: '这个会话还没有开始。任务一开始，这里就会显示它在做什么。',
        unknownSession: '还没有可显示的状态。发一句话给模型，这里就会亮起来。',
        plan: '这件事拆成了几步',
        questions: '需要你决定',
        risks: '可能的风险',
        activity: '最近做了什么',
        files: '动过的文件',
        issues: '还没解决的问题',
        planModel: '模型自己写的',
        planInferred: '按动作推断',
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
        tabTitle: 'The path',
        tabDescription: 'Where this session has been: landings, detours, and its state right now.',
        heading: 'The path',
        roadmap: 'Landings',
        noRoadmap: 'No landings yet. The path grows once something verifiable happens — a test passes, files land.',
        stuck: 'Stuck',
        detour: 'Changed course',
        filesShort: 'files',
        actionsShort: 'actions',
        open: 'Open',
        empty: 'Nothing has happened in this session yet. The card fills in once a task starts.',
        unknownSession: 'No status to show yet. Send one message and this card lights up.',
        plan: 'Broken into steps',
        questions: 'Needs your decision',
        risks: 'Risks to know',
        activity: 'What just happened',
        files: 'Files touched',
        issues: 'Unresolved',
        planModel: 'from the model',
        planInferred: 'inferred from actions',
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

    /**
     * One session's status, polled while the component is mounted.
     * @param sessionId - the session to read, or null while the slot has none.
     * @returns the current view (null until the first answer) and any error.
     */
    function useStatus(sessionId) {
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

      return { view, error }
    }

    /** The session a slot occurrence belongs to, whichever carrier passed it. */
    function sessionOf(props) {
      return props.sessionId
        ?? props.scope?.sessionId
        ?? props.session?.sessionId
        ?? props.tab?.sessionId
        ?? null
    }

    /**
     * One node of the path: a landing (filled dot) or a place it got stuck
     * (branch glyph). Newest first, joined by a hairline so the shape of the
     * session reads as one line.
     * @param props - the node, whether it is the last one, and the dictionary.
     */
    function RoadRow({ item, last, t }) {
      const fork = item.type === 'fork'
      const color = fork
        ? 'var(--dsw-alias-state-warn-primary)'
        : item.failed
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-brand-primary)'
      const label = fork ? (item.status === 'ongoing' ? t.stuck : t.detour) : item.label
      return h('div', { style: { display: 'flex', gap: 8, paddingBottom: last ? 2 : 12 } },
        h('div', { style: { flex: '0 0 12px', display: 'flex', flexDirection: 'column', alignItems: 'center' } },
          h('span', { 'aria-hidden': true, style: { color, fontSize: fork ? 11 : 9, lineHeight: '17px' } }, fork ? '⑂' : '●'),
          last ? null : h('span', { style: { flex: 1, width: 1, background: 'var(--dsw-alias-border-l1)', marginTop: 1 } }),
        ),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
            h('span', {
              style: {
                fontSize: 12.5,
                fontWeight: fork ? 500 : 600,
                color: fork ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
                whiteSpace: 'nowrap',
              },
            }, label),
            h('span', {
              title: item.detail,
              style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, item.detail),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
              humanAgo(item.ago, t)),
          ),
        ),
      )
    }

    /**
     * The card. Fetches one session's status on a timer while it is mounted.
     * @param props - `sessionId` injected by the slot; `scope` under better-sidebar.
     */
    function StatusCard(props) {
      const t = dictionary()
      const sessionId = sessionOf(props)
      const { view, error } = useStatus(sessionId)
      // One path: landings and detours, newest first.
      const road = view === null
        ? []
        : [
          ...(view.milestones ?? []).map(item => ({ ...item, type: 'milestone' })),
          ...(view.forks ?? []).map(item => ({ ...item, type: 'fork' })),
        ].sort((left, right) => right.at - left.at)

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
              h('div', { style: { ...sectionTitle, display: 'flex', alignItems: 'center', gap: 6 } },
                t.plan,
                h('span', { style: { ...chip, fontSize: 10, padding: '0 6px', fontWeight: 400 } },
                  view.planSource === 'model' ? t.planModel : t.planInferred),
              ),
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
              h('div', { style: { ...sectionTitle, color: 'var(--dsw-alias-state-error-primary)' } }, t.issues),
              h('div', { style: { fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-label-primary)' } },
                view.openIssues.map((issue, index) => h('div', { key: index }, `${issue.label}${issue.detail === '' ? '' : ` · ${issue.detail}`}`))),
            ),

            h('div', { style: sectionTitle }, t.roadmap),
            road.length === 0
              ? h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, t.noRoadmap)
              : h('div', null, road.map((item, index) => h(RoadRow, {
                key: `${item.type}-${item.at}`,
                item,
                last: index === road.length - 1,
                t,
              }))),

            // Everything that duplicates the transcript or dsh-context lives
            // here: one dim line in the corner, not a section of its own.
            h('div', {
              style: { marginTop: 14, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.85 },
            },
            h('div', null, [
              `${t.filesShort} ${view.files.length}`,
              `${t.actionsShort} ${view.stats.toolCalls}`,
              view.stats.errors > 0 ? `出错 ${view.stats.errors}` : '',
            ].filter(Boolean).join(' · ')),
            view.files.length === 0
              ? null
              : h('div', {
                title: view.files.map(file => file.path).join('\n'),
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, view.files.slice(0, 4).map(file => file.name).join('、') + (view.files.length > 4 ? ` 等 ${view.files.length} 个` : '')),
            ),

            h('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' } },
              h('div', null, t.budget),
            ),
          ),
      )
    }

    /**
     * The ambient one-liner under the composer: the card's headline without
     * opening anything. Renders nothing until the session has a status, so a
     * fresh session is not decorated.
     * @param props - `sessionId` from the slot, `open` from the registration.
     */
    function StatusStrip(props) {
      const t = dictionary()
      const { view } = useStatus(sessionOf(props))
      if (view === null) return null
      // Running: say which landing we are working away from. Idle: the anchor
      // the user asked to keep — how long ago the last step ended.
      const focus = view.focus ?? null
      const text = view.running && focus !== null
        ? `${focus.label}${focus.detail === '' ? '' : ` · ${focus.detail}`}`
        : view.headline
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '2px 10px 3px',
          fontSize: 11.5,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)',
          minWidth: 0,
        },
      },
      h('span', {
        'aria-hidden': true,
        style: { color: view.running ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)', fontSize: 8 },
      }, '●'),
      h('span', { style: { flex: '0 0 auto' } }, t.heading),
      h('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
      }, `· ${text}`),
      h('button', {
        type: 'button',
        onClick: () => props.open?.(),
        style: {
          marginLeft: 'auto',
          flex: '0 0 auto',
          border: 'none',
          background: 'none',
          padding: '0 2px',
          font: 'inherit',
          color: 'var(--dsw-alias-brand-primary)',
          cursor: 'pointer',
        },
      }, t.open),
      )
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
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

        // The ambient line under the composer: the card's one-sentence summary
        // without opening anything. This is the "always there" surface — the
        // right column may be collapsed, may be showing another tab, or may be
        // replaced by another sidebar plugin, and none of that hides this.
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: ID,
          order: 60,
          inject: () => ({ open: () => { ctx.sidebarRight?.openTab?.(KIND) } }),
        }, StatusStrip)), 'tell-the-diff: composer strip')
      },
    }
  },
})

/**
 * The session-side carrier: one monitor state per live session, fed by the
 * durable event feed, read by the HTTP route and by the tool.
 *
 * It is a cache, never a source of truth — a restart loses it and the log can
 * rebuild the same card. Keeping that promise is what makes it safe to drop
 * sessions aggressively.
 */
import { createState, reduce, noteCheckpoint, snapshot, shouldSurface } from './monitor.js'

/** How long an idle session's card survives without new events. */
const DEFAULT_RETENTION_MS = 30 * 60 * 1000
/** Hard cap on remembered sessions, so a long-lived Harness cannot grow forever. */
const MAX_SESSIONS = 40

/**
 * @param options - `now` (clock, injectable for tests), `retentionMs`.
 * @returns the store: observe, checkpoint, view, list, prune, forget.
 */
export function createMonitorStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const retentionMs = Number.isFinite(options.retentionMs) ? options.retentionMs : DEFAULT_RETENTION_MS
  /** @type {Map<string, object>} */
  const states = new Map()

  /** Create-or-read the state for a session id. */
  function ensure(sessionId, cwd) {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = createState(sessionId, { cwd })
      states.set(sessionId, state)
      if (states.size > MAX_SESSIONS) evictOldest()
    }
    return state
  }

  /** Drop the least recently touched session once the cap is crossed. */
  function evictOldest() {
    let oldest = null
    for (const [id, state] of states) {
      if (state.current !== null) continue
      if (oldest === null || state.updatedAt < states.get(oldest).updatedAt) oldest = id
    }
    if (oldest !== null) states.delete(oldest)
  }

  return {
    /**
     * Fold one committed event of one session.
     * @param session - the Harness Session it came from.
     * @param event - the recorded SessionEvent.
     */
    observe(session, event) {
      const id = String(session?.id ?? '')
      if (id === '') return
      const state = ensure(id, session?.header?.cwd)
      const next = reduce(state, event)
      if (next !== state) states.set(id, next)
    },

    /**
     * Record the model's plain-language checkpoint. An unseen session is
     * created rather than refused: writing a checkpoint must never fail the
     * model's step.
     * @param sessionId - target session.
     * @param payload - the checkpoint fields.
     * @returns the resulting view.
     */
    checkpoint(sessionId, payload) {
      const id = String(sessionId ?? '')
      const state = ensure(id)
      states.set(id, noteCheckpoint(state, payload, now()))
      return viewOf(id)
    },

    /**
     * The card for one session, plus the intervention verdict.
     * @param sessionId - target session.
     * @returns the view, or undefined while the session is unknown.
     */
    view(sessionId) {
      return viewOf(String(sessionId ?? ''))
    },

    /** Every known session's card, for the list route and for debugging. */
    list() {
      return [...states.keys()].map(id => viewOf(id)).filter(Boolean)
    },

    /** Forget sessions that have been quiet past the retention window. */
    prune() {
      const at = now()
      for (const [id, state] of states) {
        if (state.current !== null) continue
        if (at - state.updatedAt > retentionMs) states.delete(id)
      }
    },

    /** Forget one session outright (it was archived or disposed). */
    forget(sessionId) {
      states.delete(String(sessionId ?? ''))
    },
  }

  function viewOf(id) {
    const state = states.get(id)
    if (state === undefined) return undefined
    const at = now()
    return { ...snapshot(state, at), surface: shouldSurface(state, at) }
  }
}

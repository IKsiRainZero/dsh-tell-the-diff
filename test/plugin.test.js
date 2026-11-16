import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name } from '../plugin/index.js'

/** A context double that records what the plugin registered and can drive it. */
function harness() {
  const handlers = new Map()
  const effects = []
  let tool = null
  const ctx = {
    effect(factory) {
      effects.push(factory)
      const dispose = factory()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on(event, listener) {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    },
    webServer: {
      register(route) {
        handlers.set(`route:${route.path}`, route.handler)
        return () => handlers.delete(`route:${route.path}`)
      },
    },
    tools: {
      register(definition) {
        tool = definition
        return () => { tool = null }
      },
    },
  }
  return { ctx, handlers, tool: () => tool }
}

/** Drive one route into a JSON response. */
function request(handler, url, method = 'GET') {
  let status = 200
  let body = ''
  const res = {
    set statusCode(value) { status = value },
    get statusCode() { return status },
    setHeader() {},
    end(text) { body = text },
  }
  handler({ method, url }, res)
  return { status, json: body === '' ? null : JSON.parse(body) }
}

test('the host plugin declares its identity and required services', () => {
  assert.equal(name, 'dsh-tell-the-diff')
  assert.deepEqual([...inject].sort(), ['tools', 'webServer'])
  assert.equal(typeof apply, 'function')
})

test('the state route answers unknown sessions without inventing a card', () => {
  const { ctx, handlers } = harness()
  apply(ctx)
  const route = handlers.get('route:/dsh-tell-the-diff/state')
  assert.equal(request(route, '/dsh-tell-the-diff/state').json.ok, false)
  assert.deepEqual(request(route, '/dsh-tell-the-diff/state?session=s1').json, { ok: true, known: false })
})

test('the tool writes a checkpoint the state route then serves', () => {
  const { ctx, handlers, tool } = harness()
  apply(ctx)
  const definition = tool()
  assert.equal(definition.name, 'tell_the_diff')
  return definition.execute(
    { plain: '在核对需求，还没动代码。', steps: [{ title: '读现状', status: 'done' }] },
    { agent: { id: 's9' } },
  ).then((value) => {
    assert.equal(value.ok, true)
    assert.equal(value.steps, 1)
    const response = request(handlers.get('route:/dsh-tell-the-diff/state'), '/dsh-tell-the-diff/state?session=s9')
    assert.equal(response.json.known, true)
    assert.equal(response.json.view.plain, '在核对需求，还没动代码。')
  })
})

test('an event feed on a session shows up in its card', () => {
  const { ctx, handlers } = harness()
  apply(ctx)
  handlers.get('session/event')(
    { id: 's1', header: { cwd: 'C:/w' } },
    { type: 'tool/call', seq: 1, time: 1_000, data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"C:/w/src/a.js"}' } },
  )
  const response = request(handlers.get('route:/dsh-tell-the-diff/state'), '/dsh-tell-the-diff/state?session=s1')
  assert.equal(response.json.view.headline, '正在修改文件 · src/a.js')
})

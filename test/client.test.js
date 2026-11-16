import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * The browser half loads through `window.__ModuleLoader__`, which a Node test
 * does not have. This file supplies the smallest double that can prove the
 * module's shape and its two registrations — it does not render React.
 */

/** A React double: enough for module evaluation and component construction. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/** Capture what the module loader was handed. */
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}

await import('../plugin/client.js')

test('the browser half registers itself as the package name', () => {
  assert.equal(loaded.id, 'dsh-tell-the-diff')
  assert.equal(typeof loaded.factory, 'function')
})

test('applying the browser half registers one tab type and one body', () => {
  const types = []
  const slots = []
  const betterTabs = []
  const keys = []
  const module = loaded.factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
  assert.deepEqual(module.inject, ['slots', 'sidebarRightTabs', 'sidebarRight'])
  module.apply({
    effect(factory) {
      factory()
    },
    get(name) {
      return name === 'betterSidebar'
        ? { registerTab: (descriptor) => { betterTabs.push(descriptor); return () => {} } }
        : undefined
    },
    sidebarRightTabs: {
      register(definition) {
        types.push(definition)
        return () => {}
      },
    },
    sidebarRight: { openTab: () => {} },
    slots: {
      inject(ownerKey, callback) {
        keys.push(ownerKey)
        callback()
        return () => {}
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
  })

  assert.deepEqual(keys, ['sidebar.right.pane.tab', 'conversation.composer.dock'])
  assert.equal(types.length, 1)
  assert.equal(types[0].id, 'dsh-tell-the-diff')
  assert.equal(types[0].kind, 'tell-the-diff')
  assert.equal(typeof types[0].title(), 'string')
  assert.equal(types[0].guide.length, 1)
  assert.equal(typeof types[0].guide[0].description(), 'string')

  assert.equal(slots.length, 2)
  assert.equal(slots[0].options.name, 'sidebar.right.pane.tab')
  assert.equal(slots[0].options.key, 'dsh-tell-the-diff')
  assert.equal(typeof slots[0].component, 'function')
  assert.deepEqual(slots[0].options.inject('s1'), { sessionId: 's1' })

  // The ambient strip under the composer is the surface that survives a
  // collapsed or foreign right column, so it must register too.
  assert.equal(slots[1].options.name, 'conversation.composer.dock')
  assert.equal(slots[1].options.id, 'dsh-tell-the-diff')
  assert.equal(typeof slots[1].component, 'function')

  // The better-sidebar bridge shares the very same component, so the two
  // right-column carriers cannot drift apart.
  assert.equal(betterTabs.length, 1)
  assert.equal(betterTabs[0].id, 'dsh-tell-the-diff')
  assert.equal(betterTabs[0].single, true)
  assert.equal(betterTabs[0].component, slots[0].component)
})

test('the better-sidebar bridge stays out of the way when that plugin is absent', () => {
  const module = loaded.factory(() => React)
  const registrations = []
  const disposers = []
  module.apply({
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get() {
      return undefined
    },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject(ownerKey, callback) {
        callback()
        return () => {}
      },
      register() {
        registrations.push(1)
        return () => {}
      },
    },
  })
  for (const dispose of disposers) dispose()
  assert.equal(registrations.length, 2)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

function createHarness({ providers, models, sessions = [] }) {
  const handlers = new Map()
  const tools = []

  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    get(name) {
      return name === 'userQuestions' ? ctx.userQuestions : undefined
    },
    effect(effect) {
      return effect()
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    userQuestions: {
      async ask() {
        return { answers: [] }
      },
    },
    llm: {
      async listProviders() {
        return providers
      },
      async listModels(provider) {
        return models[provider] ?? []
      },
    },
    sessions: {
      list() {
        return sessions
      },
      get(id) {
        return sessions.find((session) => session.id === id)
      },
    },
  }

  return { ctx, handlers, tools }
}

function createSession(id, { origin, parentSession, events = [] } = {}) {
  const session = {
    id,
    header: { origin, parentSession },
    appended: [],
    snapshotEvents() {
      return [...events, ...session.appended]
    },
    append(type, data) {
      session.appended.push({ type, data })
    },
  }
  return session
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('seeds a live top-level session with every connected model', async () => {
  const session = createSession('s1')
  const { ctx, appends } = createHarness({
    providers: [
      { id: 'p1', name: 'P1' },
      { id: 'p2', name: 'P2' },
    ],
    models: {
      p1: [{ id: 'm1' }, { id: 'm2' }],
      p2: [{ id: 'm3' }],
    },
    sessions: [session],
  })

  apply(ctx, {})
  await tick()

  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'subagent/model-selection-policy')
  assert.deepEqual(session.appended[0].data.allowedModels, [
    { provider: 'p1', model: 'm1' },
    { provider: 'p1', model: 'm2' },
    { provider: 'p2', model: 'm3' },
  ])
})

test('refreshes before a subagent tool call and skips unchanged routes', async () => {
  const session = createSession('s1')
  const models = { p1: [{ id: 'm1' }] }
  const { ctx, handlers } = createHarness({
    providers: [{ id: 'p1', name: 'P1' }],
    models,
    sessions: [session],
  })

  apply(ctx, {})
  await tick()
  assert.equal(session.appended.length, 1)

  const preExecute = handlers.get('tools/pre-execute')
  const next = async () => ({ kind: 'allow' })
  await preExecute(
    { name: 'list_subagent_models', agent: { session } },
    next,
  )
  assert.equal(session.appended.length, 1)

  models.p1.push({ id: 'm2' })
  await preExecute(
    { name: 'subagent', agent: { session } },
    next,
  )
  assert.equal(session.appended.length, 2)
  assert.deepEqual(session.appended[1].data.allowedModels, [
    { provider: 'p1', model: 'm1' },
    { provider: 'p1', model: 'm2' },
  ])
})

test('copies the parent policy into a subagent session', async () => {
  const parent = createSession('parent')
  const child = createSession('child', {
    origin: 'subagent',
    parentSession: 'parent',
  })
  const { ctx, handlers } = createHarness({
    providers: [{ id: 'p1', name: 'P1' }],
    models: { p1: [{ id: 'm1' }] },
    sessions: [parent, child],
  })

  apply(ctx, {})
  await tick()

  const created = handlers.get('agent/created')
  await created({ agent: { session: child } })

  assert.equal(parent.appended.length, 1)
  assert.equal(child.appended.length, 1)
  assert.deepEqual(child.appended[0].data.allowedModels, [
    { provider: 'p1', model: 'm1' },
  ])
})

test('does nothing when disabled', async () => {
  const session = createSession('s1')
  const { ctx } = createHarness({
    providers: [{ id: 'p1', name: 'P1' }],
    models: { p1: [{ id: 'm1' }] },
    sessions: [session],
  })

  apply(ctx, { enabled: false })
  await tick()

  assert.equal(session.appended.length, 0)
})

test('cascading picker asks provider then only that provider’s models', async () => {
  const session = createSession('s1')
  const { ctx, tools } = createHarness({
    providers: [
      { id: 'p1', name: 'P1' },
      { id: 'p2', name: 'P2' },
    ],
    models: {
      p1: [{ id: 'm1' }, { id: 'm2' }],
      p2: [{ id: 'm3' }],
    },
    sessions: [session],
  })

  const asked = []
  const answers = [
    { answers: [{ id: 'provider', selected: ['p2'], custom: '' }] },
    { answers: [{ id: 'model', selected: ['m3'], custom: '' }] },
  ]
  ctx.userQuestions.ask = async (request) => {
    asked.push(request.questions[0])
    return answers.shift()
  }

  apply(ctx, {})
  await tick()

  const tool = tools.find((definition) => definition.name === 'pick_subagent_model')
  assert.ok(tool)
  const result = await tool.execute(
    { task: '核对版本号' },
    { agent: { session }, signal: new AbortController().signal },
  )

  assert.deepEqual(result, { provider: 'p2', model: 'm3' })
  assert.equal(asked.length, 2)
  assert.deepEqual(
    asked[0].options.map((option) => option.label),
    ['p1', 'p2'],
  )
  assert.deepEqual(
    asked[1].options.map((option) => option.label),
    ['m3'],
  )
  assert.match(asked[1].question, /p2/)
})

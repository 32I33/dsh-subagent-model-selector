/**
 * Make every model that is connected to DSH available to the official
 * subagent model picker.
 *
 * DSH records a `subagent/model-selection-policy` snapshot when a top-level
 * session is created. The stock settings owner fills that snapshot from a
 * fixed allowlist. This plugin writes the same event type, but derives the
 * list from the live `llm` registry: `listProviders()` x `listModels()`.
 *
 * The policy is refreshed before `list_subagent_models` and `subagent` run,
 * and whenever the provider topology changes. That turns the snapshot into a
 * live view without teaching a new session event type.
 */

const POLICY_EVENT = 'subagent/model-selection-policy'
const REFRESH_TOOLS = new Set(['list_subagent_models', 'subagent'])

export const name = 'subagent-model-selector'

export const inject = ['llm', 'sessions', 'tools']

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const includeProviders = stringList(config.includeProviders)
  const excludeProviders = stringList(config.excludeProviders)
  const refreshBeforeToolCalls = config.refreshBeforeToolCalls !== false
  const refreshOnAdapterChange = config.refreshOnAdapterChange !== false
  // Optional: a headless profile may not mount a user-question service. The
  // policy refresh still works there; only the interactive picker is absent.
  const userQuestions = ctx.get('userQuestions')

  /** One in-flight task per session id, so concurrent tool calls cannot race. */
  const inflight = new Map()
  /** Last policy observed or written, keyed by the live Session object. */
  const lastKnown = new WeakMap()

  const warn = (message, error) => {
    console.warn(`[subagent-model-selector] ${message}`, error)
  }

  async function collectRoutes() {
    const providers = await ctx.llm.listProviders()
    const routes = []
    const seen = new Set()

    for (const provider of providers) {
      if (includeProviders.length > 0 && !includeProviders.includes(provider.id)) continue
      if (excludeProviders.includes(provider.id)) continue

      let models
      try {
        models = await ctx.llm.listModels(provider.id)
      } catch (error) {
        warn(`could not list models for provider "${provider.id}"`, error)
        continue
      }

      for (const model of models) {
        const key = `${provider.id}\u0000${model.id}`
        if (seen.has(key)) continue
        seen.add(key)
        routes.push({ provider: provider.id, model: model.id })
      }
    }

    return routes
  }

  function readPolicy(session) {
    if (lastKnown.has(session)) return lastKnown.get(session)

    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== POLICY_EVENT) continue
      const routes = event.data.allowedModels
      lastKnown.set(session, routes)
      return routes
    }

    lastKnown.set(session, undefined)
    return undefined
  }

  function sameRoutes(left, right) {
    if (left === right) return true
    if (!left || !right || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (left[index].provider !== right[index].provider) return false
      if (left[index].model !== right[index].model) return false
    }
    return true
  }

  function appendPolicy(session, routes) {
    if (!Array.isArray(routes) || routes.length === 0) return false
    if (sameRoutes(readPolicy(session), routes)) return false

    const allowedModels = routes.map(({ provider, model }) => ({ provider, model }))
    session.append(POLICY_EVENT, { allowedModels })
    lastKnown.set(session, allowedModels)
    return true
  }

  async function ensurePolicy(session) {
    if (readPolicy(session)) return false

    if (session.header.origin === 'subagent') {
      const parentId = session.header.parentSession
      const parent = parentId ? ctx.sessions.get(parentId) : undefined
      const inherited = parent ? readPolicy(parent) : undefined
      return inherited && inherited.length > 0 ? appendPolicy(session, inherited) : false
    }

    return appendPolicy(session, await collectRoutes())
  }

  async function refreshPolicy(session) {
    if (session.header.origin === 'subagent') return false
    return appendPolicy(session, await collectRoutes())
  }

  function serialize(session, task) {
    const key = session.id
    const previous = inflight.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    inflight.set(key, next)
    return next.finally(() => {
      if (inflight.get(key) === next) inflight.delete(key)
    })
  }

  const ensure = (session) => serialize(session, () => ensurePolicy(session))
  const refresh = (session) => serialize(session, () => refreshPolicy(session))

  function cleanChoice(value) {
    return String(value)
      .replace(/\s*\((?:recommended|推荐)\)\s*$/i, '')
      .replace(/（(?:recommended|推荐)）\s*$/, '')
      .trim()
  }

  function recommendedRoute(value) {
    if (typeof value !== 'string') return undefined
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) return undefined
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
  }

  async function askOne(exec, question) {
    const result = await userQuestions.ask({
      agent: exec.agent,
      signal: exec.signal,
      questions: [question],
    })
    const answer = result.answers.find((item) => item.id === question.id)
    if (!answer) return ''
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
    return cleanChoice(custom || answer.selected[0] || '')
  }

  if (userQuestions !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.register({
        name: 'pick_subagent_model',
        description:
          'Ask the user to pick a subagent model with a cascading choice: choose a provider, then choose one of that provider’s models. Both questions happen inside this one tool call, so do not call ask_user_question between the two steps. Returns {provider, model}, or {skipped: true, reason} when the user skips.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task: {
              type: 'string',
              description: 'Short summary of the subagent task, shown to the user.',
            },
            recommended: {
              type: 'string',
              description: 'Optional recommended route as "provider/model".',
            },
          },
          required: ['task'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              skipped: { type: 'boolean' },
              reason: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        isConcurrencySafe: () => false,
        when: ({ agent }) => agent?.session?.header?.origin !== 'subagent',
        async execute(args, exec) {
          if (!exec.agent) throw new Error('pick_subagent_model requires a calling agent')

          const task =
            typeof args?.task === 'string' && args.task.trim().length > 0
              ? args.task.trim()
              : 'subagent 任务'
          const recommended = recommendedRoute(args?.recommended)
          const routes = await collectRoutes()
          if (routes.length === 0) return { skipped: true, reason: 'DSH 当前没有已连接的模型' }

          const grouped = new Map()
          for (const route of routes) {
            const models = grouped.get(route.provider) ?? []
            models.push(route.model)
            grouped.set(route.provider, models)
          }

          let providers = [...grouped.keys()]
          if (recommended !== undefined && grouped.has(recommended.provider)) {
            providers = [
              recommended.provider,
              ...providers.filter((provider) => provider !== recommended.provider),
            ]
          }

          let provider
          if (providers.length === 1) {
            provider = providers[0]
          } else {
            const choice = await askOne(exec, {
              id: 'provider',
              header: '子智能体 provider',
              question: `为「${task}」选择 provider。当前共 ${providers.length} 个 provider、${routes.length} 个模型。`,
              options: providers.map((id) => ({
                label: `${id}${recommended?.provider === id ? ' (Recommended)' : ''}`,
                description: `${grouped.get(id).length} 个模型`,
              })),
            })

            if (!choice) return { skipped: true, reason: '用户跳过了 provider 选择' }
            if (grouped.has(choice)) {
              provider = choice
            } else {
              const slash = choice.indexOf('/')
              const typedProvider = slash > 0 ? choice.slice(0, slash) : ''
              const typedModel = slash > 0 ? choice.slice(slash + 1) : ''
              if (typedProvider && grouped.get(typedProvider)?.includes(typedModel)) {
                return { provider: typedProvider, model: typedModel }
              }
              return { skipped: true, reason: `无法识别 provider：${choice}` }
            }
          }

          let models = grouped.get(provider) ?? []
          if (recommended?.provider === provider && models.includes(recommended.model)) {
            models = [recommended.model, ...models.filter((model) => model !== recommended.model)]
          }
          if (models.length === 0) return { skipped: true, reason: `provider ${provider} 没有模型` }

          const choice = await askOne(exec, {
            id: 'model',
            header: '子智能体模型',
            question: `已选 provider：${provider}。为「${task}」选择模型（共 ${models.length} 个）。`,
            options: models.map((model) => ({
              label: `${model}${
                recommended?.provider === provider && recommended.model === model
                  ? ' (Recommended)'
                  : ''
              }`,
              ...(recommended?.provider === provider && recommended.model === model
                ? { description: '推荐' }
                : {}),
            })),
          })

          if (!choice) return { skipped: true, reason: '用户跳过了模型选择' }
          if (models.includes(choice)) return { provider, model: choice }

          const prefix = `${provider}/`
          if (choice.startsWith(prefix) && models.includes(choice.slice(prefix.length))) {
            return { provider, model: choice.slice(prefix.length) }
          }
          return { skipped: true, reason: `无法识别模型：${choice}` }
        },
      }),
      'subagent-model-selector: picker tool',
    )
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ensure(agent.session)
    } catch (error) {
      warn('could not seed the session policy', error)
    }
  })

  if (refreshOnAdapterChange) {
    ctx.on('llm/adapters-updated', () => {
      for (const session of ctx.sessions.list()) {
        if (session.header.origin === 'subagent') continue
        void refresh(session).catch((error) => warn('could not refresh a live session', error))
      }
    })
  }

  if (refreshBeforeToolCalls) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!exec.agent || !REFRESH_TOOLS.has(exec.name)) return next()
      try {
        await refresh(exec.agent.session)
      } catch (error) {
        warn(`could not refresh models before "${exec.name}"`, error)
      }
      return next()
    })
  }

  // Sessions that were already live when this plugin activated (including the
  // one installing it) do not emit `agent/created` again.
  for (const session of ctx.sessions.list()) {
    if (session.header.origin === 'subagent') continue
    void ensure(session).catch((error) => warn('could not seed a live session', error))
  }
}

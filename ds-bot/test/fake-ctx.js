// DSH's `attachments` service (dsh-attachment-local), in memory. A file ref has a
// name and is read as a stream, in small chunks that split characters as a stream
// may. An image ref, as a prompt's image block stores it, has no name: only
// readImage reads it, and a file read refuses it as DSH does.
export function fakeAttachments() {
  const files = new Map()
  let next = 0
  const id = () => `sha256:${String(++next).padStart(64, '0')}`
  return {
    files,
    async saveFile({ data, name }) {
      const ref = { attachmentId: id(), name, bytes: data.length }
      files.set(ref.attachmentId, data)
      return ref
    },
    async saveImage({ data, mediaType, width, height }) {
      const ref = { attachmentId: id(), mediaType, bytes: data.length, width, height }
      files.set(ref.attachmentId, data)
      return ref
    },
    async* readFileStream(ref) {
      if (typeof ref.name !== 'string' || ref.name === '') throw Object.assign(new Error('File attachment reference is invalid.'), { code: 'INVALID_ATTACHMENT_REF' })
      const data = files.get(ref.attachmentId)
      if (data === undefined) throw new Error('no such file')
      for (let at = 0; at < data.length; at += 1001) yield data.subarray(at, at + 1001)
    },
    async readImage(ref) {
      const data = files.get(ref.attachmentId)
      if (data === undefined || ref.name !== undefined) throw Object.assign(new Error('Image attachment reference is invalid.'), { code: 'INVALID_ATTACHMENT_REF' })
      return { ref, data: new Uint8Array(data) }
    },
  }
}

export function fakeApproval(outcome = 'allowed-once') {
  const requests = []
  return {
    requests,
    async request(request) {
      requests.push(request)
      return typeof outcome === 'function' ? outcome(requests.length, request) : outcome
    },
  }
}

// A stand-in for the plugin context that records what apply() registers, in order,
// without starting any service.
export function fakeContext({ services = {} } = {}) {
  const calls = []
  const disposers = []
  const registeredTools = new Map()
  const guards = []
  // Listeners by event name, in registration order.
  const listeners = new Map()
  const sections = new Map()
  const ctx = {
    calls,
    registeredTools,
    guards,
    listeners,
    sections,
    logger: { warn() {}, info() {} },
    get: name => services[name],
    // As in real cordis: the plugin does not inject this service, so reading it throws.
    get subagents() { throw new Error('cannot get property "subagents" without inject') },
    // The real ctx guards plain access with `inject`; service() reads this.
    reflect: { get: name => ctx.get(name) },
    on(name, listener, options) {
      calls.push(`on ${name}${options?.prepend ? ' (prepend)' : ''}`)
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    // Calls the plain listeners of an event; middleware (with `next`) is not run.
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) listener(payload)
      }
    },
    // emit, but waits for async listeners — for paths like agent/created whose
    // work must finish before the test goes on.
    async emitAsync(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) await listener(payload)
      }
    },
    // An Agent handle for sessionId whose own tool scope feeds the same map the
    // global registrations use — how agent.ctx.tools.register looks to the host.
    scopeAgent(sessionId) {
      return {
        id: sessionId,
        session: { id: sessionId },
        ctx: {
          tools: { register: (tool) => { registeredTools.set(tool.name, tool); return () => {} } },
          effect: () => {},
          on: () => () => {},
        },
      }
    },
    effect(execute, label) {
      calls.push(`effect ${label}`)
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    // Settles once every cleanup has, including the writes some of them wait for.
    dispose() {
      return Promise.allSettled(disposers.splice(0).reverse().map(dispose => dispose()))
    },
    tools: {
      register(tool) {
        calls.push(`tool ${tool.name}`)
        registeredTools.set(tool.name, tool)
        return () => {}
      },
      guard(guard) {
        calls.push('tools guard')
        guards.push(guard)
        return () => {}
      },
      schemas: () => [],
    },
    systemPrompt: {
      section(section) {
        calls.push(`prompt ${section.name} ${section.order}`)
        sections.set(section.name, section)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          calls.push(`route ${route.methods.join(',')} ${route.path}`)
          return () => {}
        },
      },
    },
    llm: {
      listProviders: () => [],
      registerAdapter: (routes, adapter) => {
        ctx.adapters = [...(ctx.adapters ?? []), { routes, adapter }]
        const handle = () => {}
        handle.replace = (next) => { ctx.adapters.at(-1).routes = next }
        return handle
      },
    },
  }
  return ctx
}

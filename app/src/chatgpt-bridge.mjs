const METHODS = new Set(['chatgpt:status', 'chatgpt:sign-in', 'chatgpt:cancel', 'chatgpt:sign-out', 'chatgpt:models', 'chatgpt:route'])

export function createChatGPTBridge({ signIn, relay, getSignIn, getRelay, openExternal }) {
  let signingIn
  let closed = false
  let resolvedSignIn = signIn
  let resolvedRelay = relay
  let signInPromise
  let relayPromise

  const ensureSignIn = () => {
    if (resolvedSignIn) return Promise.resolve(resolvedSignIn)
    signInPromise ??= Promise.resolve().then(getSignIn).then((value) => {
      resolvedSignIn = value
      return value
    }, (error) => {
      signInPromise = undefined
      throw error
    })
    return signInPromise
  }

  const ensureRelay = () => {
    if (closed) return Promise.reject(new Error('ChatGPT bridge closed.'))
    if (resolvedRelay) return Promise.resolve(resolvedRelay)
    relayPromise ??= ensureSignIn().then(si => getRelay(si)).then(async (value) => {
      if (closed) {
        try {
          await Promise.resolve(value.close()).catch(() => {})
        } finally {
          relayPromise = undefined
        }
        throw new Error('ChatGPT bridge closed.')
      }
      resolvedRelay = value
      return value
    }, (error) => {
      relayPromise = undefined
      throw error
    })
    return relayPromise
  }

  const request = async (method, body = {}) => {
    switch (method) {
      case 'chatgpt:status': return (await ensureSignIn()).status()
      case 'chatgpt:route': return (await ensureRelay()).route()
      case 'chatgpt:models': return (await ensureSignIn()).listModels()
      case 'chatgpt:cancel': {
        signingIn?.abort()
        return (await ensureSignIn()).status()
      }
      case 'chatgpt:sign-out': {
        signingIn?.abort()
        return (await ensureSignIn()).signOut()
      }
      case 'chatgpt:sign-in': {
        if (signingIn) throw new Error('Sign-in is already running.')
        const controller = new AbortController()
        signingIn = controller
        try {
          const si = await ensureSignIn()
          return await si.signIn({ openExternal, signal: controller.signal, consent: body?.consent === true })
        } finally {
          signingIn = undefined
        }
      }
      default: throw new Error('Unknown ChatGPT request.')
    }
  }
  return {
    handle(message, send) {
      if (message?.type !== 'ds-bot:chatgpt' || typeof message.id !== 'string' || !METHODS.has(message.method)) return false
      const reply = response => { try { send(response) } catch {} }
      void request(message.method, message.body).then(result => reply({ type: 'ds-bot:chatgpt-response', id: message.id, result }),
        () => reply({ type: 'ds-bot:chatgpt-response', id: message.id, error: { ...(resolvedSignIn?.status() ?? { state: 'temporarily-unavailable' }), message: 'ChatGPT request could not complete. Check the connection status.' } }))
      return true
    },
    close() {
      closed = true
      signingIn?.abort()
      if (resolvedRelay) return Promise.resolve(resolvedRelay.close())
      if (relayPromise) return relayPromise.then(value => value.close(), () => {})
      return Promise.resolve()
    },
  }
}

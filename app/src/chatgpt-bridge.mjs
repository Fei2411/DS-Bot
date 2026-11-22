const METHODS = new Set(['chatgpt:status', 'chatgpt:sign-in', 'chatgpt:cancel', 'chatgpt:sign-out', 'chatgpt:models', 'chatgpt:route'])

export function createChatGPTBridge({ signIn, relay, openExternal }) {
  let signingIn
  const request = async (method, body = {}) => {
    switch (method) {
      case 'chatgpt:status': return signIn.status()
      case 'chatgpt:route': return relay.route()
      case 'chatgpt:models': return signIn.listModels()
      case 'chatgpt:cancel': signingIn?.abort(); return signIn.status()
      case 'chatgpt:sign-out': signingIn?.abort(); return signIn.signOut()
      case 'chatgpt:sign-in': {
        if (signingIn) throw new Error('Sign-in is already running.')
        const controller = new AbortController()
        signingIn = controller
        try { return await signIn.signIn({ openExternal, signal: controller.signal, consent: body?.consent === true }) }
        finally { signingIn = undefined }
      }
      default: throw new Error('Unknown ChatGPT request.')
    }
  }
  return {
    handle(message, send) {
      if (message?.type !== 'ds-bot:chatgpt' || typeof message.id !== 'string' || !METHODS.has(message.method)) return false
      const reply = response => { try { send(response) } catch {} }
      void request(message.method, message.body).then(result => reply({ type: 'ds-bot:chatgpt-response', id: message.id, result }),
        () => reply({ type: 'ds-bot:chatgpt-response', id: message.id, error: { ...signIn.status(), message: 'ChatGPT request could not complete. Check the connection status.' } }))
      return true
    },
    close() { signingIn?.abort(); return relay.close() },
  }
}

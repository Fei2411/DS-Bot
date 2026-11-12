// Official controller transport backed by DS Bot's own tenant-token REST client.
// Only card/controller calls use this; no channel or session controller.

export function officialConfig(fields, env, base) {
  return { channels: { feishu: {
    appId: fields.appId, appSecret: fields.appSecret, enabled: true,
    domain: fields.domain === 'lark' ? 'lark' : 'feishu', baseUrl: base,
    ...(env.config?.tableRenderMode === 'native' ? { tableRenderMode: 'native' } : {}),
  } } }
}

export function officialRuntime(log) {
  const safe = (level, message, meta) => log?.[level]?.('ds-bot im: feishu %s %o', String(message), meta ?? '')
  const logger = {
    debug: (message, meta) => safe('debug', message, meta),
    info: (message, meta) => safe('info', message, meta),
    warn: (message, meta) => safe('warn', message, meta),
    error: (message, meta) => safe('error', message, meta),
  }
  return { logging: { getChildLogger: () => logger }, logger }
}

export function officialSdk(rest, { base, fetch: fetchImpl = globalThis.fetch } = {}) {
  const request = async (path, { params, data, method = 'POST', ...more } = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    const suffix = query.size ? `?${query}` : ''
    const response = await rest(`${path}${suffix}`, { method, body: data, ...more })
    if (response?.code !== undefined && response.code !== 0) {
      const error = new Error(response.msg ?? `Feishu API error ${response.code}`)
      error.code = response.code
      error.msg = response.msg
      error.status = response.httpStatus
      throw error
    }
    return response
  }
  const named = path => input => request(path, { data: input?.data, params: input?.params, ...input?.request })
  const pathId = (template, input) => template.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(String(input?.path?.[name] ?? '')))
  const action = (template, method = 'POST') => input => request(pathId(template, input), { data: input?.data, params: input?.params, method, ...input?.request })
  const formRequest = async (url, fields, fileField, file, fileName = 'attachment') => {
    if (Buffer.isBuffer(file) === false && typeof file?.pipe !== 'function') throw new Error('DS Bot only uploads in-memory media')
    let bytes
    if (Buffer.isBuffer(file)) bytes = file
    else {
      const chunks = []
      let length = 0
      for await (const chunk of file) {
        const part = Buffer.from(chunk)
        length += part.length
        if (length > 20 * 1024 * 1024) { file.destroy?.(); throw new Error('Media exceeds the 20 MiB upload limit') }
        chunks.push(part)
      }
      bytes = Buffer.concat(chunks)
    }
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Media exceeds the 20 MiB upload limit')
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
    form.set(fileField, new Blob([bytes]), fileField === 'image' ? 'image' : fileName)
    const response = await fetchImpl(`${base}${url}`, { method: 'POST', headers: { authorization: `Bearer ${await rest.token()}` }, body: form })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || (body.code !== undefined && body.code !== 0)) {
      const error = new Error(body.msg ?? `Feishu upload failed (${response.status})`)
      error.code = body.code
      error.status = response.status
      throw error
    }
    return body
  }
  return {
    request: ({ method = 'GET', url, params, data }) => request(url, { params, data, method }),
    cardkit: { v1: {
      card: {
        create: named('/open-apis/cardkit/v1/cards'),
        update: action('/open-apis/cardkit/v1/cards/{card_id}', 'PUT'),
        settings: action('/open-apis/cardkit/v1/cards/{card_id}/settings', 'PATCH'),
      },
      cardElement: {
        content: action('/open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content', 'PUT'),
      },
    } },
    im: {
      message: {
        create: input => request('/open-apis/im/v1/messages', { data: input?.data, params: { ...input?.params, ...(input?.data?.uuid ? { uuid: input.data.uuid } : {}) }, ...input?.request }),
        reply: action('/open-apis/im/v1/messages/{message_id}/reply'),
        patch: action('/open-apis/im/v1/messages/{message_id}', 'PATCH'),
      },
      image: { create: ({ data }) => formRequest('/open-apis/im/v1/images', { image_type: data.image_type }, 'image', data.image) },
      file: { create: ({ data }) => formRequest('/open-apis/im/v1/files', { file_type: data.file_type, file_name: data.file_name }, 'file', data.file, data.file_name) },
    },
    contact: { user: { batch: named('/open-apis/contact/v3/users/batch') } },
  }
}


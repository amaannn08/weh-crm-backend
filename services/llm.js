export async function streamChat(messages, streamCallback) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set')
  }

  const url = 'https://api.deepseek.com/chat/completions'

  const body = {
    model: 'deepseek-chat',
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content
    })),
    stream: true
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `DeepSeek chat request failed with ${response.status} ${response.statusText}: ${text.slice(
        0,
        200
      )}`
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')

  let done = false
  let buffer = ''

  while (!done) {
    const result = await reader.read()
    done = result.done
    if (result.value) {
      buffer += decoder.decode(result.value, { stream: true })

      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)

        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') {
          continue
        }

        try {
          const json = JSON.parse(data)
          const delta = json.choices?.[0]?.delta
          const text = delta?.content || delta?.reasoning_content || ''
          if (text) {
            streamCallback(text)
          }
        } catch {
          // ignore malformed JSON chunks
        }
      }
    }
  }
}

/**
 * Non-streaming call with tool definitions.
 * Returns the full message object (may include tool_calls array).
 */
export async function callWithTools(messages, tools) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set')

  const toolDefs = tools.map((t) => ({
    type: 'function',
    function: {
      name: t.id,
      description: t.description,
      parameters: t.inputSchema
    }
  }))

  const body = {
    model: 'deepseek-chat',
    messages,
    tools: toolDefs,
    tool_choice: 'auto',
    stream: false
  }

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`DeepSeek tool-call request failed ${response.status}: ${text.slice(0, 200)}`)
  }

  const json = await response.json()
  return json.choices?.[0]?.message ?? null
}

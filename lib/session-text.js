/**
 * 会话 → 转录 → 一段独立的小上下文。没有任何一处读「主对话的上下文」，
 * 全部是重新拼出来的纯文本，所以这些调用的账单和会话长度无关。
 *
 * @module dsh-life-diary/session-text
 */

/** 常见密钥形态，写进仓库前先抹掉。 */
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
]

/** 截断到 max 个字符，尾部加省略号。 */
export function trunc(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 抹掉常见密钥形态，以及调用方明确指出的那一个令牌。
 * @param text - 待清洗的文本。
 * @param token - 需要逐字替换掉的令牌（可为空）。
 */
export function scrubSecrets(text, token) {
  let out = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[已脱敏]')
  if (token && token.length >= 8) out = out.split(token).join('[已脱敏]')
  return out
}

/**
 * 宽松 JSON 解析：容忍模型把 JSON 包在 markdown 围栏里，或前后多说了两句。
 * @returns 解析结果，失败返回 undefined。
 */
export function parseJsonLoose(text) {
  const value = String(text ?? '')
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(value.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** 把内容块数组拍平成纯文本。 */
function contentBlocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`[工具调用 ${block.name}(${trunc(block.arguments, 160)})]`)
        break
      case 'tool-result':
        parts.push(`[工具结果 ${trunc(contentBlocksToText(block.content), 300)}]`)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'file':
        parts.push(`[文件 ${block.attachment?.name ?? ''}]`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/**
 * 把会话事件流序列化成「用户 / 助手」风格的转录文本，超长时保留尾部。
 * @param session - 会话对象（需要 `snapshotEvents()`）。
 * @param maxChars - 最大字符数。
 * @returns 转录文本；读不到会话事件时返回空串。
 */
export function buildTranscript(session, maxChars) {
  const lines = []
  try {
    for (const event of session.snapshotEvents()) {
      switch (event.type) {
        case 'user/message': {
          const text = contentBlocksToText(event.data?.content).trim()
          if (text) lines.push(`[用户] ${text}`)
          break
        }
        case 'assistant/message': {
          const text = contentBlocksToText(event.data?.message?.content).trim()
          if (text) lines.push(`[助手] ${text}`)
          break
        }
        case 'tool/call':
          lines.push(`[工具调用] ${event.data?.name}(${trunc(event.data?.arguments, 200)})`)
          break
        case 'tool/result': {
          const text = contentBlocksToText(event.data?.message?.content).trim()
          if (text) lines.push(`[工具结果] ${trunc(text, 300)}`)
          break
        }
        default:
          break
      }
    }
  } catch {
    // 读不到会话事件时返回空转录，由调用方按「太短」跳过
    return ''
  }
  let text = lines.join('\n').trim()
  if (text.length > maxChars) text = `……（更早的对话已省略）……\n${text.slice(-maxChars)}`
  return text
}

/**
 * 挑一个模型：显式配置 > 会话自己的选择 > 部署默认。
 * @returns `{ provider, model }`，都确定不了时返回 undefined。
 */
export function pickModel(ctx, session, config) {
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  try {
    const header = session?.requestHeader?.()
    if (header?.config?.provider && header?.config?.model) {
      return { provider: header.config.provider, model: header.config.model }
    }
  } catch {
    /* 会话可能已分离 */
  }
  const service = ctx.get('agentDefaultModel')
  if (service && typeof service.currentSelection === 'function') {
    try {
      const selection = service.currentSelection()
      if (selection?.provider && selection?.model) {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      /* 落入失败 */
    }
  }
  return undefined
}

/**
 * 一次完整的补全：拿独立的小上下文问一句话，攒出全文。
 * @param llm - `ctx.get('llm')` 拿到的服务。
 * @param model - `{ provider, model }`。
 * @param system - 系统提示。
 * @param user - 用户消息。
 * @param stallMs - 单块最长静默时间；超时判失败，避免永远挂着。
 * @returns 模型输出的全文。
 */
export async function complete(llm, model, system, user, stallMs = 120000) {
  const chunks = []
  let finish
  const iterator = llm
    .stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.4,
    })
    [Symbol.asyncIterator]()

  while (true) {
    let timer
    let step
    try {
      step = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`日记模型调用超时（${Math.round(stallMs / 1000)} 秒无输出）`)), stallMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (step.done) break
    const chunk = step.value
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
    if (chunk.type === 'finish') finish = chunk.reason
  }

  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    throw new Error(`日记模型调用失败: ${finish.kind} ${finish.failure?.message ?? ''}`)
  }
  return chunks.join('')
}

/**
 * 判断一本日记里有没有「正文」——去掉标题行、引用行和空行之后，还剩没剩
 * 一条像样的内容。只剩表头的那本按空的算，所以不会拿一页空壳去汇总。
 *
 * 注意阈值按「有没有一句话」算，不按总字数算：一天只留了一条短碎片，
 * 那也是写过日记的一天，不该被当成空白的。
 */
export function hasContent(text) {
  const body = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('>'))
  return body.some((line) => line.replace(/^[-*·\d.]+\s*/, '').length >= 4)
}

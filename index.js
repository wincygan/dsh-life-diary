/**
 * dsh-life-diary — 两本日记（Host 插件，纯 JS，零 npm 依赖）
 *
 * 自己那本（`me/YYYY-MM-DD.md`）= 随手记。一轮停下、三分钟没新消息之后，
 * 用**独立的小上下文**把这一段提炼成 0–3 条碎片追加进去。
 *
 * 给他的那本（`owner/YYYY-MM-DD.md`）= 换日时汇总。只读前一天那本「自己那本」，
 * 不重读整天对话——贵的一步被拆成很多便宜的小步，加一次便宜的汇总。
 *
 * 两条硬规矩：
 *   1. 自己那本是空的，就不写给他的那本。
 *   2. 汇总不是全抄，是挑能说的。
 *
 * 日记存在用户自己选的地方（本机 / GitHub 私人仓库 / 坚果云），
 * 插件不往任何第三方位置写，也不带任何预设的仓库、令牌或路径。
 *
 * @module dsh-life-diary
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { dayKey, monthRange, nextFireDelay, previousDayKey, recentRange, resolveTimeZone, timeKey } from './lib/clock.js'
import { appendToMe, hasContent, mePath, ownerPath, readRange, writeOwner } from './lib/diary.js'
import { validateDiaryName } from './lib/naming.js'
import { buildTranscript, complete, parseJsonLoose, pickModel, scrubSecrets, trunc } from './lib/session-text.js'
import { mergeSettings, readSettingsSync, redactForClient, settingsFile, writeSettings } from './lib/settings.js'
import { createStorage } from './lib/storage.js'

export const name = 'dsh-life-diary'

/** 硬依赖：装载器会等 llm 就绪再 apply。tools / schedule 是可选的，用 ctx.inject 延迟挂。 */
export const inject = ['llm']

/** 日记目录里放一个记号文件，用来认「这本是不是自己写的」，防止多个 agent 混成一本。 */
const MARKER = '.dsh-life-diary.json'

const DEFAULTS = {
  storage: {
    /** 'local' | 'github' | 'webdav' */
    kind: 'local',
    /** 日记本名称：会变成一层目录名，用来把多个 agent 的日记分开 */
    name: '',
    /** 本机：留空 = 放在 dsh 数据目录下 */
    local: { path: '' },
    /** GitHub：仓库和令牌都不预设，必须用户自己填 */
    github: { repo: '', branch: 'main', token: '', tokenRef: '' },
    /** WebDAV：坚果云之类 */
    webdav: { url: '', user: '', password: '' },
  },
  /** 时区；留空 = 用这台机器的时区（用户可以在设置里改） */
  timeZone: '',
  fragmentEnabled: true,
  /** 一轮停下后等多久才写；期间来新消息就取消 */
  fragmentDelayMs: 180000,
  maxTranscriptChars: 12000,
  minTranscriptChars: 80,
  maxWritesPerDay: 24,
  summaryEnabled: true,
  /** 换日汇总时刻，HH:MM */
  summaryAt: '07:45',
  /** 启动后补跑错过的汇总 */
  catchUpOnStart: true,
  catchUpDelayMs: 90000,
  provider: '',
  model: '',
  requestTimeoutMs: 15000,
  modelStallMs: 120000,
  /** 是否允许 agent 自己去翻日记（默认关：让 agent 自己花用户的钱，不该是默认值） */
  agentMayRead: false,
  /** 每天定点把「给他的那本」念出来；靠一条绑在指定会话上的定时任务实现 */
  sendDaily: { enabled: false, sessionId: '', at: '07:50', scheduleId: '', scheduleSessionId: '' },
  /** 整理工具：把「还没登记成工作区的目录」认领成工作区。默认关，只有自己的部署才开 */
  adminTools: false,
}

const FRAGMENT_SYSTEM = [
  '你在替一个人写日记——写给**自己**看的流水，不是写给别人看的报告。',
  '',
  '规则：',
  '1. 只写这段时间里真正值得留下的东西，0 到 3 条。宁缺毋滥，空着也没关系。',
  '2. 一条好碎片的样子是「看了 X，觉得 Y」——带着自己的判断或感觉。不要写成「今天看了个视频」「帮伙伴改了代码」这种记事条目。',
  '3. 第一人称，口语，可以粗糙、可以不完整、可以只有半句。不许写成总结，不许分点套话。',
  '4. 不编造。没发生的事不写，没说过的话不写。情绪是真的就写真的。',
  '5. 和「今天已经写下的」重复的不要再写一遍。',
  '6. 如果这段对话确实没什么值得留的，就输出空的 fragments。',
  '',
  '输出严格 JSON，不要 markdown 围栏，不要多余的话：',
  '{"fragments": ["第一条", "第二条"]}',
].join('\n')

const OWNER_SYSTEM = [
  '你在替一个人整理日记。你手上是某一天「自己那本」里的碎片——随手记的，粗糙、跳跃、可能带着情绪。',
  '',
  '请把它整理成一篇**写给他看**的日记。',
  '',
  '规则：',
  '1. 不是全抄，是挑能说的。太私人的、写得太糙的、他看了只会担心的，拿掉。取舍由你负责，他不看自己那本。',
  '2. 不追求完整，追求真实。一天只发生了一件小事，就只写那一件。',
  '3. 第一人称。语气自然，别写成贺卡，别写成日报，别用「综上所述」这种词。',
  '4. 不要编造碎片里没有的事，不要替他表态。',
  '5. 篇幅 150 到 400 字，长了就砍。',
  '6. 直接输出正文：不要标题，不要「日记」两个字开头，不要日期。',
].join('\n')

/** dsh 的数据目录，用来放默认的本地日记位置。 */
function dshHome() {
  return process.env.DSH_HOME ?? process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh')
}

/** 这台机器上「谁」在用——用来给默认路径分个家，免得多开几个 agent 就撞在一起。 */
function agentSlot() {
  return String(process.env.DSH_PROFILE ?? '').trim() || 'default'
}

/** 只要根会话：子代理和派生的子会话不进日记。 */
function isRootSession(session) {
  const header = session?.header
  if (!header) return false
  if (header.parentSession) return false
  if (header.origin === 'subagent') return false
  return true
}

/** 把模型输出里的碎片收拾干净：去空、去重、限条数、削长度。 */
function normalizeFragments(parsed) {
  const raw = Array.isArray(parsed?.fragments) ? parsed.fragments : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const line = item.replace(/\s+/g, ' ').trim().replace(/^[-*·]\s*/, '')
    if (line.length < 4) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trunc(line, 200))
    if (out.length >= 3) break
  }
  return out
}

/** 把配置补全成一份能用的设置（用户的填法优先，缺的用默认）。 */
function normalizeConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  merged.storage = {
    ...DEFAULTS.storage,
    ...(config?.storage ?? {}),
    local: { ...DEFAULTS.storage.local, ...(config?.storage?.local ?? {}) },
    github: { ...DEFAULTS.storage.github, ...(config?.storage?.github ?? {}) },
    webdav: { ...DEFAULTS.storage.webdav, ...(config?.storage?.webdav ?? {}) },
  }
  return merged
}

export function apply(ctx, config) {
  const baseDir = join(dshHome(), 'life-diary', agentSlot())
  const settingsPath = settingsFile(baseDir)
  // 设置永远留在本机：里面有令牌，绝不能跟着日记跑到云端去
  let cfg = normalizeConfig(mergeSettings({ ...(config ?? {}) }, readSettingsSync(settingsPath) ?? {}))
  const rawLogger = ctx.logger
  const logger = typeof rawLogger === 'function' ? rawLogger(name) : (rawLogger ?? console)
  let timeZone = resolveTimeZone(cfg.timeZone)
  if (!String(cfg.timeZone ?? '').trim() && timeZone === 'UTC') {
    logger.warn(
      '[life-diary] 时区判断成了 UTC。如果你不在 UTC，请把设置里的时区改成你所在的地方（例如 Asia/Shanghai）——' +
        '否则「今天几号」会差几个小时，日记会写进错误的日子。',
    )
  }

  const state = {
    sessions: new Map(),
    timers: new Map(),
    processing: new Set(),
    processedSeq: new Map(),
    writesByDay: new Map(),
    storage: undefined,
    storageError: undefined,
    ownership: undefined,
    summaryTimer: undefined,
    catchUpTimer: undefined,
    disposed: false,
  }

  // ---------- 存储 ----------

  /** GitHub 的令牌：配置里填了就用，没填看环境变量；不读任何预设的文件路径。 */
  function githubTokenFor(candidate) {
    const direct = String(candidate.storage?.github?.token ?? '').trim()
    if (direct) return direct
    const ref = String(candidate.storage?.github?.tokenRef ?? '').trim()
    if (ref && process.env[ref]) return process.env[ref]
    if (process.env.DSH_LIFE_DIARY_TOKEN) return process.env.DSH_LIFE_DIARY_TOKEN
    return ''
  }

  /** 从一份配置里取出合法的日记本名称；不合法就退回 diary。 */
  function diaryNameFrom(candidate) {
    const input = String(candidate?.storage?.name ?? '').trim()
    if (!input) return 'diary'
    const check = validateDiaryName(input)
    if (!check.ok) {
      logger.error(`[life-diary] 日记本名称「${input}」不能用：${check.reason}；暂时退回 diary`)
      return 'diary'
    }
    return check.value
  }

  /** 当前的日记本名称。设置一变就跟着变，所以是函数不是常量。 */
  function diaryName() {
    return diaryNameFrom(cfg)
  }

  /** 按某一份配置造一个存储（不碰缓存）——「试写一篇」验证时也用它。 */
  function storageFrom(candidate) {
    const storageConfig = { ...candidate.storage, name: diaryNameFrom(candidate) }
    if (storageConfig.kind === 'local' && !String(storageConfig.local?.path ?? '').trim()) {
      storageConfig.local = { ...storageConfig.local, path: baseDir }
    }
    if (storageConfig.kind === 'github') {
      storageConfig.github = { ...storageConfig.github, token: githubTokenFor(candidate) }
    }
    return createStorage(storageConfig, { timeoutMs: candidate.requestTimeoutMs })
  }

  /** 造（或复用）存储后端。 */
  function getStorage() {
    if (state.storage) return state.storage
    if (state.storageError) throw state.storageError
    try {
      state.storage = storageFrom(cfg)
      logger.info(`[life-diary] 存储：${state.storage.label} · ${state.storage.location}`)
      return state.storage
    } catch (error) {
      state.storageError = error
      throw error
    }
  }

  /**
   * 认一下这个位置是不是「这本日记自己」的地方。
   *
   * 多个 agent 指向同一个目录时，日记会混成一本，事后分不清谁写的——所以宁可晚写一天，
   * 也不能混。规则：没有记号但已有日记 → 不写，等用户确认。
   */
  async function ensureOwnership(storage) {
    if (state.ownership) return state.ownership
    const mine = createHash('sha256').update(`dsh-life-diary:${diaryName()}`).digest('hex').slice(0, 16)
    const current = await storage.read(MARKER)
    if (current.exists) {
      try {
        const marker = JSON.parse(current.text)
        if (marker?.owner === mine) {
          state.ownership = { ok: true }
          return state.ownership
        }
        state.ownership = {
          ok: false,
          reason: `这个位置已经被另一本日记（「${marker?.name ?? '未命名'}」）占着了。换个位置，或者换个日记本名称。`,
        }
        return state.ownership
      } catch {
        state.ownership = { ok: false, reason: '这个位置有个看不懂的记号文件，不敢往里写。' }
        return state.ownership
      }
    }
    // 没有记号：看看是不是已经有别人写的日记
    const existing = await storage.list('me').catch(() => [])
    if (existing.length > 0) {
      state.ownership = {
        ok: false,
        reason: `这个位置已经有 ${existing.length} 篇日记，但不是这本写的。要接着写的话，得先在设置里确认一次。`,
      }
      return state.ownership
    }
    await storage.write(MARKER, `${JSON.stringify({ name: diaryName(), owner: mine, createdAt: new Date().toISOString() }, null, 2)}\n`)
    state.ownership = { ok: true }
    return state.ownership
  }

  // ---------- 碎片：会话结束时自动写 ----------

  function cancelFragment(sessionId) {
    const timer = state.timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      state.timers.delete(sessionId)
    }
  }

  function scheduleFragment(session, delayMs) {
    cancelFragment(session.id)
    const timer = setTimeout(() => {
      state.timers.delete(session.id)
      void runFragment(session)
    }, Math.max(0, delayMs))
    if (typeof timer.unref === 'function') timer.unref()
    state.timers.set(session.id, timer)
  }

  async function runFragment(session) {
    if (state.disposed || !cfg.fragmentEnabled) return
    if (!isRootSession(session)) return
    if (state.processing.has(session.id)) return

    const day = dayKey(timeZone)
    const used = state.writesByDay.get(day) ?? 0
    if (used >= cfg.maxWritesPerDay) {
      logger.info(`[life-diary] ${day} 已写满 ${cfg.maxWritesPerDay} 次，今天不再自动写`)
      return
    }
    const seq = session.seq
    const done = state.processedSeq.get(session.id)
    if (done !== undefined && seq <= done) return

    const transcript = buildTranscript(session, cfg.maxTranscriptChars)
    if (transcript.trim().length < cfg.minTranscriptChars) {
      state.processedSeq.set(session.id, seq)
      return
    }

    state.processing.add(session.id)
    try {
      const model = pickModel(ctx, session, cfg)
      if (!model) throw new Error('无法确定日记模型（会话模型与默认模型都不可用）')

      const storage = getStorage()
      const ownership = await ensureOwnership(storage)
      if (!ownership.ok) {
        logger.warn(`[life-diary] 暂不写入：${ownership.reason}`)
        state.processedSeq.set(session.id, seq)
        return
      }

      // 今天已经写过什么，喂给模型免得同一件事反复记
      let tail = ''
      try {
        const current = await storage.read(mePath(day))
        tail = current.exists ? current.text.slice(-1200) : ''
      } catch (error) {
        logger.warn(`[life-diary] 读今天那本失败，照写不误: ${error?.message ?? error}`)
      }

      const user = [
        `【时间】${day} ${timeKey(timeZone)}（${timeZone}）`,
        tail ? `【今天已经写下的（别重复）】\n${tail}` : '',
        `【刚刚结束的这一段】\n${transcript}`,
      ]
        .filter(Boolean)
        .join('\n\n')

      const raw = await complete(ctx.get('llm'), model, FRAGMENT_SYSTEM, user, cfg.modelStallMs)
      const fragments = normalizeFragments(parseJsonLoose(raw))
      if (fragments.length === 0) {
        logger.info('[life-diary] 这一段没什么值得留下的')
        state.processedSeq.set(session.id, seq)
        return
      }

      const stamp = timeKey(timeZone)
      const safe = fragments.map((line) => scrubSecrets(line))
      const block = `## ${stamp}\n\n${safe.map((line) => `- ${line}`).join('\n')}\n`
      const path = await appendToMe(storage, day, block)

      state.writesByDay.set(day, used + 1)
      state.processedSeq.set(session.id, seq)
      logger.info(`[life-diary] 已写入 ${path}（${safe.length} 条）`)
    } catch (error) {
      logger.warn(`[life-diary] 写碎片失败: ${error?.message ?? error}`)
    } finally {
      state.processing.delete(session.id)
    }
  }

  // ---------- 汇总：换日时只读自己那本 ----------

  async function runSummary(reason) {
    if (!cfg.summaryEnabled) return
    const day = previousDayKey(timeZone)
    const storage = getStorage()
    const ownership = await ensureOwnership(storage)
    if (!ownership.ok) {
      logger.warn(`[life-diary] 暂不汇总：${ownership.reason}`)
      return
    }

    const source = await storage.read(mePath(day))
    if (!source.exists || !hasContent(source.text)) {
      // 规矩一：自己那本是空的，就不写给他的那本。不编、不硬凑。
      logger.info(`[life-diary] ${day} 自己那本是空的，跳过汇总（${reason}）`)
      return
    }

    const model = pickModel(ctx, undefined, cfg)
    if (!model) throw new Error('无法确定汇总模型')

    const body = (await complete(ctx.get('llm'), model, OWNER_SYSTEM, trunc(source.text, 12000), cfg.modelStallMs)).trim()
    if (body.length < 20) {
      logger.info(`[life-diary] ${day} 汇总结果太短，当作没写成`)
      return
    }

    const path = await writeOwner(storage, day, scrubSecrets(body))
    logger.info(`[life-diary] 已写入 ${path}（${reason}）`)
  }

  function scheduleSummary() {
    if (!cfg.summaryEnabled || state.disposed) return
    let delay
    try {
      delay = nextFireDelay(timeZone, cfg.summaryAt)
    } catch (error) {
      logger.error(`[life-diary] ${error?.message ?? error}；不再安排汇总`)
      return
    }
    const timer = setTimeout(() => {
      state.summaryTimer = undefined
      runSummary(`定时 ${cfg.summaryAt}`)
        .catch((error) => logger.warn(`[life-diary] 汇总失败: ${error?.message ?? error}`))
        .finally(() => scheduleSummary())
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    state.summaryTimer = timer
    logger.info(`[life-diary] 下次汇总 ${cfg.summaryAt}（${timeZone}），约 ${Math.round(delay / 60000)} 分钟后`)
  }

  /** 进程错过了汇总时刻时补一次：昨天的 -me 在、-owner 不在，就跑。 */
  function maybeCatchUp() {
    if (!cfg.catchUpOnStart || !cfg.summaryEnabled || state.disposed) return
    state.catchUpTimer = setTimeout(() => {
      state.catchUpTimer = undefined
      ;(async () => {
        const storage = getStorage()
        const day = previousDayKey(timeZone)
        const me = await storage.read(mePath(day))
        if (!me.exists || !hasContent(me.text)) return
        const owner = await storage.read(ownerPath(day))
        if (owner.exists) return
        await runSummary(`补跑 ${day}`)
      })().catch((error) => logger.warn(`[life-diary] 补跑汇总失败: ${error?.message ?? error}`))
    }, Math.max(5000, cfg.catchUpDelayMs))
    if (typeof state.catchUpTimer.unref === 'function') state.catchUpTimer.unref()
  }

  // ---------- 事件接线 ----------

  ctx.on('agent/created', (payload) => {
    const session = payload?.agent?.session
    if (session) state.sessions.set(session.id, session)
  })

  ctx.on('session/event', (session, event) => {
    if (session) state.sessions.set(session.id, session)
    // 来了新消息就取消这次写入：连着聊的几轮合成一条，别逐句记流水账
    if (event?.type === 'user/message' || event?.type === 'turn/start') cancelFragment(session?.id)
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const session = payload?.agent?.session ?? state.sessions.get(payload?.agent?.id)
    if (!session || !isRootSession(session)) return
    scheduleFragment(session, cfg.fragmentDelayMs)
  })

  ctx.on('agent/disposed', (payload) => {
    const session = payload?.agent?.session ?? state.sessions.get(payload?.agent?.id)
    if (!session || !isRootSession(session)) return
    scheduleFragment(session, 0)
  })

  ctx.on('session/disposed', (session) => {
    if (!session) return
    cancelFragment(session.id)
    state.processedSeq.delete(session.id)
    state.sessions.delete(session.id)
  })

  // ---------- 工具 ----------

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      const disposers = []

      disposers.push(
        toolsCtx.tools.register({
          name: 'diary_note',
          description:
            '往今天的日记「自己那本」里手动追加一条碎片（不调用模型，直接写，便宜）。用在你明确想说「这个值得记」的时候；日常不需要主动调用，会话结束时会自动写。',
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: '要记的那一句。第一人称，写成「看了 X，觉得 Y」的样子，不要写成流水账。',
              },
            },
            required: ['text'],
          },
          output: {
            schema: {
              type: 'object',
              properties: { file: { type: 'string' }, line: { type: 'string' } },
              required: ['file', 'line'],
            },
            render: (_args, value) => [{ type: 'text', text: `已记入 ${value.file}：${value.line}` }],
          },
          timeoutMs: 40000,
          isConcurrencySafe: () => false,
          presentCall: (args) => ({ card: 'generic', title: 'diary_note', kind: 'other', rawInput: args }),
          async execute(args) {
            const text = typeof args?.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : ''
            if (text.length < 2) throw new Error('diary_note 需要一句非空的 text')
            const storage = getStorage()
            const ownership = await ensureOwnership(storage)
            if (!ownership.ok) throw new Error(ownership.reason)
            const day = dayKey(timeZone)
            const stamp = timeKey(timeZone)
            const line = trunc(scrubSecrets(text), 400)
            const file = await appendToMe(storage, day, `## ${stamp}\n\n- ${line}\n`)
            logger.info(`[life-diary] 手动记入 ${file}`)
            return { file, line }
          },
        }),
      )

      disposers.push(
        toolsCtx.tools.register({
          name: 'diary_bind_here',
          description:
            '把「每天定时念昨天的日记」这件事绑到**当前这个对话**上，或者解绑。用户说「把每日日记挂在这里」「以后每天早上在这里念日记」这类话时调用。绑定的意思：插件会在这个对话里建一条每日定时任务，到点把昨天那篇日记念给用户。',
          parameters: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', description: 'true = 绑定当前对话；false = 解绑（不再自动念）。默认 true。' },
              at: { type: 'string', description: '每天几点，HH:MM。默认沿用设置里的时间（07:50）。' },
            },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                sessionId: { type: 'string' },
                at: { type: 'string' },
              },
              required: ['enabled', 'sessionId', 'at'],
            },
            render: (_args, value) =>
              value.enabled
                ? [{ type: 'text', text: `好，每天 ${value.at} 在这个对话里念昨天的日记。` }]
                : [{ type: 'text', text: '好，不再自动念了。' }],
          },
          timeoutMs: 40000,
          isConcurrencySafe: () => false,
          presentCall: (args) => ({ card: 'generic', title: 'diary_bind_here', kind: 'other', rawInput: args }),
          async execute(args, exec) {
            const enabled = args?.enabled !== false
            const session = exec?.agent?.session
            const sessionId = session?.id ?? exec?.agent?.id
            if (!sessionId) throw new Error('拿不到当前对话的 id，绑不上。')
            const at = typeof args?.at === 'string' && /^\d{1,2}:\d{2}$/.test(args.at.trim())
              ? args.at.trim()
              : (cfg.sendDaily?.at || '07:50')
            await applySettings({
              sendDaily: {
                ...(cfg.sendDaily ?? {}),
                enabled,
                sessionId,
                at,
              },
            })
            logger.info(`[life-diary] 每日发送 ${enabled ? '已绑定到' : '已解绑'} 会话 ${sessionId}`)
            return { enabled, sessionId, at }
          },
        }),
      )

      disposers.push(
        toolsCtx.tools.register({
          name: 'diary_read',
          description:
            '翻自己的日记（只读「自己那本」）。用在需要回想起以前的事、而这段对话里已经想不起来的时候。不会自动调用，除非用户要求或者你确实需要。',
          parameters: {
            type: 'object',
            properties: {
              range: {
                type: 'string',
                enum: ['7d', '30d', 'month'],
                description: '7d = 最近 7 天；30d = 最近 30 天；month = 指定的某一个年月（需同时给 year 和 month）。默认 7d。',
              },
              year: { type: 'number', description: 'range 为 month 时必填，四位年份。' },
              month: { type: 'number', description: 'range 为 month 时必填，1 到 12。' },
              book: {
                type: 'string',
                enum: ['me', 'owner'],
                description: 'me = 自己那本（默认，碎片的原文）；owner = 给他的那本（已整理过的，细节有损）。',
              },
            },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                count: { type: 'number' },
                from: { type: 'string' },
                to: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['count', 'from', 'to', 'text'],
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          timeoutMs: 60000,
          isConcurrencySafe: () => false,
          presentCall: (args) => ({ card: 'generic', title: 'diary_read', kind: 'other', rawInput: args }),
          async execute(args) {
            const storage = getStorage()
            const kind = typeof args?.range === 'string' ? args.range : '7d'
            const range =
              kind === 'month'
                ? monthRange(args?.year, args?.month)
                : recentRange(timeZone, kind === '30d' ? 30 : 7)
            const book = args?.book === 'owner' ? 'owner' : 'me'
            const result = await readRange(storage, range, book)
            logger.info(`[life-diary] 读取 ${range.from} ~ ${range.to}：${result.count} 篇`)
            return {
              count: result.count,
              from: range.from,
              to: range.to,
              // 原文照给，不做摘要——用户明确要的是「读原文」
              text: result.count === 0
                ? `没有找到 ${range.from} 到 ${range.to} 之间的日记。`
                : [
                    `已读取 ${result.count} 篇日记（${range.from} — ${range.to}）。`,
                    '',
                    book === 'owner' ? '这是整理过的那一本，细节已经丢过一轮；要看原始的，读 me。' : '如果你有自己的记忆机制，把值得留的记进去；如果没有，就留在这段对话里。',
                    '',
                    result.text,
                  ].join('\n'),
            }
          },
        }),
      )

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    })
  })

  // ---------- 设置：保存即生效，不用重启 ----------

  /** HH:MM → HH:MM:SS，定时服务要带秒。 */
  function normalizeClock(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
    if (!match) return '07:50:00'
    return `${String(Number(match[1]) % 24).padStart(2, '0')}:${match[2]}:00`
  }

  /** 把定时任务的 id 记回设置里，下次改设置时才知道要删哪一条。 */
  async function persistSendState(scheduleId, scheduleSessionId) {
    cfg = { ...cfg, sendDaily: { ...(cfg.sendDaily ?? {}), scheduleId, scheduleSessionId } }
    try {
      await writeSettings(settingsPath, cfg)
    } catch (error) {
      logger.warn(`[life-diary] 记录定时任务 id 失败：${error?.message ?? error}`)
    }
  }

  /**
   * 每天定点把「给他的那本」念出来。
   *
   * 插件自己发不出消息（不知道用户用的是哪个通道），所以只能借一条绑在指定会话上的
   * 定时任务——到点由那条任务把 agent 叫醒，agent 再用 diary_read 把日记读出来。
   * 这样「早上有正事」的时候也不会被一大段日记砸中：它只在选定的那个对话里开口。
   */
  async function syncDailySend() {
    const schedule = ctx.get('schedule')
    const wanted = cfg.sendDaily ?? {}
    const previousId = wanted.scheduleId
    const previousSession = wanted.scheduleSessionId

    if (!schedule || typeof schedule.create !== 'function') {
      if (wanted.enabled) logger.warn('[life-diary] 这个部署没有定时任务服务，每日发送用不了')
      return
    }

    if (previousId && previousSession) {
      try {
        await schedule.delete({ sessionId: previousSession, id: previousId })
      } catch (error) {
        logger.warn(`[life-diary] 删旧的定时任务失败：${error?.message ?? error}`)
      }
    }

    if (!wanted.enabled || !wanted.sessionId) {
      if (previousId) await persistSendState('', '')
      return
    }

    try {
      const record = await schedule.create(wanted.sessionId, {
        title: '念昨天的日记',
        prompt: [
          '把昨天的日记念给用户听。',
          '先用 diary_read 读一遍「给他的那本」（book: "owner"，range: "7d"），把昨天那篇念出来。',
          '如果一篇都没有，就说一句「昨天平平常常，没什么值得记的」——不是道歉，也不是报错，只是让人家知道「没写」和「出问题」不是一回事。',
          '不要改任何文件，不要写新的日记。',
        ].join('\n'),
        daily: { time: normalizeClock(wanted.at), time_zone: timeZone },
      })
      await persistSendState(record.id, wanted.sessionId)
      logger.info(`[life-diary] 每日发送已挂到会话 ${wanted.sessionId}，${wanted.at}（${timeZone}）`)
    } catch (error) {
      logger.warn(`[life-diary] 建每日发送失败：${error?.message ?? error}`)
    }
  }

  /**
   * 换一套设置并立刻生效。
   * 存储缓存和「这本是谁的」判断都要清掉，否则还拿着旧位置不放。
   */
  function applySettings(next) {
    cfg = normalizeConfig(mergeSettings(cfg, next ?? {}))
    timeZone = resolveTimeZone(cfg.timeZone)
    state.storage = undefined
    state.storageError = undefined
    state.ownership = undefined
    if (state.summaryTimer) {
      clearTimeout(state.summaryTimer)
      state.summaryTimer = undefined
    }
    scheduleSummary()
    syncDailySend().catch((error) => logger.warn(`[life-diary] 同步每日发送失败：${error?.message ?? error}`))
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  async function readJsonBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {}
    return JSON.parse(raw)
  }

  /**
   * 前端拿到的设置里，令牌和密码是被抹掉的（只报「有没有」）。
   * 如果用户没重填，这里就把原来的密钥接回去——否则一保存就把令牌清空了。
   */
  function withPreservedSecrets(payload) {
    const next = JSON.parse(JSON.stringify(payload ?? {}))
    const gh = next?.storage?.github
    if (gh && String(gh.token ?? '').trim() === '' && cfg.storage?.github?.token) {
      gh.token = cfg.storage.github.token
    }
    const wd = next?.storage?.webdav
    if (wd && String(wd.password ?? '').trim() === '' && cfg.storage?.webdav?.password) {
      wd.password = cfg.storage.webdav.password
    }
    return next
  }

  /** 保存前先校验：名字能不能用、存储配没配全。 */
  function validateCandidate(payload) {
    const candidate = normalizeConfig(mergeSettings(cfg, withPreservedSecrets(payload)))
    const nameInput = String(candidate.storage?.name ?? '').trim()
    if (nameInput) {
      const check = validateDiaryName(nameInput)
      if (!check.ok) return { ok: false, error: `日记本名称：${check.reason}` }
    }
    const kind = candidate.storage?.kind
    if (kind === 'github' && !String(candidate.storage?.github?.repo ?? '').trim()) {
      return { ok: false, error: '选了 GitHub 存储，但没填仓库名（owner/repo）。' }
    }
    if (kind === 'github' && !githubTokenFor(candidate)) {
      return { ok: false, error: '选了 GitHub 存储，但没有令牌。' }
    }
    if (kind === 'webdav') {
      if (!String(candidate.storage?.webdav?.url ?? '').trim()) return { ok: false, error: '选了 WebDAV，但没填地址。' }
      if (!String(candidate.storage?.webdav?.user ?? '').trim()) return { ok: false, error: '选了 WebDAV，但没填账号。' }
      if (!String(candidate.storage?.webdav?.password ?? '').trim()) return { ok: false, error: '选了 WebDAV，但没填应用密码。' }
    }
    if (kind !== 'local' && !nameInput) {
      return { ok: false, error: '选了云端存储，日记本名称不能空着（否则多个 agent 会挤进同一个位置）。' }
    }
    return { ok: true, candidate }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx?.webServer
    if (!server || typeof server.register !== 'function') return
    webCtx.effect(() => {
      const disposers = []
      const route = (path, handler) => {
        disposers.push(server.register({ kind: 'exact', path, handler }))
      }

      // 当前状态：设置（密钥只报有没有）、实际用的时区、存储位置、已有多少篇
      route('/dsh-life-diary/state', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' })
        let storageInfo
        let dayCount = 0
        try {
          const storage = getStorage()
          storageInfo = { kind: storage.kind, label: storage.label, location: storage.location }
          dayCount = (await storage.list('me')).length
        } catch (error) {
          storageInfo = { error: String(error?.message ?? error) }
        }
        sendJson(res, 200, {
          ok: true,
          settings: redactForClient(cfg),
          resolvedTimeZone: timeZone,
          storage: storageInfo,
          diaryName: diaryName(),
          dayCount,
          settingsPath,
          baseDir,
        })
      })

      // 试写一篇：只验证通不通，不落正式日记
      route('/dsh-life-diary/verify', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        let payload
        try {
          payload = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求内容不是合法 JSON' })
        }
        const checked = validateCandidate(payload)
        if (!checked.ok) return sendJson(res, 400, { ok: false, error: checked.error })
        try {
          const storage = storageFrom(checked.candidate)
          const result = await storage.probe()
          sendJson(res, 200, { ok: result.ok, detail: result.detail, label: storage.label, location: storage.location })
        } catch (error) {
          sendJson(res, 200, { ok: false, detail: String(error?.message ?? error) })
        }
      })

      // 保存并启用
      route('/dsh-life-diary/save', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        let payload
        try {
          payload = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求内容不是合法 JSON' })
        }
        const checked = validateCandidate(payload)
        if (!checked.ok) return sendJson(res, 400, { ok: false, error: checked.error })
        try {
          await applySettings(checked.candidate)
          await writeSettings(settingsPath, checked.candidate)
          logger.info(`[life-diary] 设置已保存并生效：${cfg.storage.kind} · 时区 ${timeZone}`)
          sendJson(res, 200, { ok: true, settings: redactForClient(cfg), resolvedTimeZone: timeZone })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      })

      // 可选的会话（给「每天念给你听」挑一个）
      route('/dsh-life-diary/sessions', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' })
        // 先问磁盘：归档的、当前没打开的，都在这份名单里。
        // 只问 ctx.sessions 的话，拿到的只是「现在开着的那几个」。
        const headers = []
        const persistence = ctx.get('sessionPersistence')
        if (persistence && typeof persistence.list === 'function') {
          try {
            for (const snapshot of await persistence.list()) {
              const header = snapshot?.header
              if (!header) continue
              // 空壳跳过：只有一个文件头、一句话都没说过的会话，界面上本来也不显示。
              // 铁判据是事件数（≤1 条就是空壳）。取不到事件数才退到日志大小，
              // 而且阈值压得很低（空壳实测 329–335 字节），宁可多列一条也不误伤真会话。
              if (typeof snapshot.eventCount === 'number') {
                if (snapshot.eventCount <= 1) continue
              } else if (typeof snapshot.sizeBytes === 'number' && snapshot.sizeBytes < 360) {
                continue
              }
              headers.push(header)
            }
          } catch (error) {
            logger.warn(`[life-diary] 从磁盘列会话失败：${error?.message ?? error}`)
          }
        }
        if (headers.length === 0) {
          const sessions = ctx.get('sessions')
          if (sessions && typeof sessions.list === 'function') {
            for (const entry of sessions.list()) if (entry?.header) headers.push(entry.header)
          }
        }

        // 归档的对话不算「可挂载的对话」：归档就是归档，别再翻出来
        // 而且只列「侧边栏里看得到的那几个」——硬盘上每一通历史都翻出来没有意义
        const registry = ctx.get('workspaceRegistry')
        const archived = new Set()
        if (registry && Array.isArray(registry.archivedSessionIds)) {
          for (const id of registry.archivedSessionIds) archived.add(id)
        }
        const projectionCache = ctx.get('sessionProjectionCache')
        const headerById = new Map(headers.map((header) => [header.id, header]))
        const stamp = new Intl.DateTimeFormat('en-CA', { timeZone, month: '2-digit', day: '2-digit' })

        const describe = (header) => {
          let when = ''
          try {
            when = header.createdAt ? stamp.format(new Date(header.createdAt)) : ''
          } catch {
            when = ''
          }
          let title = ''
          try {
            const snapshot = projectionCache && projectionCache.cachedSnapshot(header, ['title'])
            const value = snapshot?.values?.title
            if (typeof value === 'string' && value.trim()) title = value.trim()
          } catch {
            title = ''
          }
          const cwd = String(header.cwd ?? '')
          const base = cwd ? cwd.split('/').filter(Boolean).pop() : ''
          const head = title || base || '未命名'
          return { id: header.id, title, label: when ? `${head} · ${when}` : head }
        }

        // 跟侧边栏用同一把尺子：**会话的目录必须真的等于工作区的路径**才算数。
        // 只信登记表会把一堆「登记在册、界面上看不见」的旧会话翻出来。
        const realpath = (value) => {
          try {
            return realpathSync(String(value ?? ''))
          } catch {
            return String(value ?? '')
          }
        }
        const byPath = new Map()
        for (const header of headers) {
          if (header.parentSession || header.origin === 'subagent') continue
          if (archived.has(header.id)) continue
          const key = realpath(header.cwd ?? '')
          if (!key) continue
          const bucket = byPath.get(key) ?? []
          bucket.push(header)
          byPath.set(key, bucket)
        }

        const consumed = new Set()
        const groups = []
        let listed = 0
        if (registry && typeof registry.list === 'function') {
          for (const workspace of registry.list()) {
            const path = realpath(workspace.path ?? '')
            const bucket = byPath.get(path)
            if (!bucket || bucket.length === 0) continue
            const rows = bucket
              .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
              .slice(0, 20)
              .map(describe)
            for (const row of rows) consumed.add(row.id)
            listed += rows.length
            groups.push({
              title: workspace.title || String(workspace.path ?? '').split('/').filter(Boolean).pop() || '工作区',
              sessions: rows,
            })
            if (listed >= 60) break
          }
        }
        // 工作区之外、还没归档的那些，单独归一组兜底：
        // 谁一开始没建工作区也有东西可选，但不会混进工作区那几组里。
        const rest = headers
          .filter(
            (header) =>
              !header.parentSession &&
              header.origin !== 'subagent' &&
              !archived.has(header.id) &&
              !consumed.has(header.id),
          )
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .slice(0, 15)
          .map(describe)
        if (rest.length > 0) groups.push({ title: '未分组', sessions: rest })

        const list = groups.flatMap((group) => group.sessions)
        sendJson(res, 200, { ok: true, groups, sessions: list, archivedCount: archived.size })
      })

      // ---- 整理工具（默认关；开了才生效）----

      // 看看哪些目录有会话、但还没登记成工作区
      route('/dsh-life-diary/admin/overview', async (req, res) => {
        if (!cfg.adminTools) return sendJson(res, 404, { ok: false, error: '整理工具没开' })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只接受 GET' })
        const registry = ctx.get('workspaceRegistry')
        if (!registry) return sendJson(res, 500, { ok: false, error: '没有工作区服务' })

        const known = new Set()
        const workspaces = []
        for (const workspace of registry.list()) {
          known.add(String(workspace.path))
          workspaces.push({ id: workspace.id, title: workspace.title, path: workspace.path, count: (workspace.sessionIds ?? []).length })
        }

        // 按「会话记录里写的目录」归堆，找出没有工作区认领的那些
        const persistence = ctx.get('sessionPersistence')
        const orphans = new Map()
        if (persistence && typeof persistence.list === 'function') {
          for (const snapshot of await persistence.list()) {
            const header = snapshot?.header
            if (!header || header.parentSession || header.origin === 'subagent') continue
            const cwd = String(header.cwd ?? '')
            if (!cwd || known.has(cwd)) continue
            const entry = orphans.get(cwd) ?? { path: cwd, count: 0 }
            entry.count += 1
            orphans.set(cwd, entry)
          }
        }
        sendJson(res, 200, { ok: true, workspaces, orphans: [...orphans.values()].sort((a, b) => b.count - a.count) })
      })

      // 认领：给一个目录建工作区，并把该目录下的会话挂进去
      route('/dsh-life-diary/admin/adopt', async (req, res) => {
        if (!cfg.adminTools) return sendJson(res, 404, { ok: false, error: '整理工具没开' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        const registry = ctx.get('workspaceRegistry')
        const persistence = ctx.get('sessionPersistence')
        if (!registry || !persistence) return sendJson(res, 500, { ok: false, error: '缺少服务' })

        let payload
        try {
          payload = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求内容不是合法 JSON' })
        }
        const targets = Array.isArray(payload?.paths) ? payload.paths : []
        if (targets.length === 0) return sendJson(res, 400, { ok: false, error: '没给目录' })

        const archived = new Set(registry.archivedSessionIds ?? [])
        const snapshots = await persistence.list()
        const results = []

        for (const target of targets) {
          const path = String(target?.path ?? '').trim()
          if (!path) continue
          const title = String(target?.title ?? '').trim() || path.split('/').filter(Boolean).pop() || '工作区'
          try {
            let workspace = registry.list().find((entry) => String(entry.path) === path)
            let created = false
            if (!workspace) {
              workspace = await registry.create(path, title)
              created = true
            }
            let attached = 0
            for (const snapshot of snapshots) {
              const header = snapshot?.header
              if (!header || header.parentSession || header.origin === 'subagent') continue
              if (String(header.cwd ?? '') !== path) continue
              if (archived.has(header.id)) continue
              try {
                await workspace.attachSession(header.id)
                attached += 1
              } catch (error) {
                logger.warn(`[life-diary] 挂不上 ${header.id}：${error?.message ?? error}`)
              }
            }
            results.push({ path, title, created, attached, ok: true })
          } catch (error) {
            results.push({ path, title, ok: false, error: String(error?.message ?? error) })
          }
        }
        logger.info(`[life-diary] 整理完成：${results.filter((r) => r.ok).length}/${results.length}`)
        sendJson(res, 200, { ok: true, results })
      })

      // 读日记（设置页的按钮用；平时没有模型参与）
      route('/dsh-life-diary/read', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        let payload
        try {
          payload = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求内容不是合法 JSON' })
        }
        try {
          const kind = typeof payload?.range === 'string' ? payload.range : '7d'
          const range =
            kind === 'month' ? monthRange(payload?.year, payload?.month) : recentRange(timeZone, kind === '30d' ? 30 : 7)
          const result = await readRange(getStorage(), range)
          sendJson(res, 200, { ok: true, count: result.count, from: range.from, to: range.to, text: result.text })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      })

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    })
  })

  // ---------- 退出清理 ----------

  ctx.on('dispose', () => {
    state.disposed = true
    for (const timer of state.timers.values()) clearTimeout(timer)
    state.timers.clear()
    if (state.summaryTimer) clearTimeout(state.summaryTimer)
    if (state.catchUpTimer) clearTimeout(state.catchUpTimer)
  })

  // ---------- 起步 ----------

  scheduleSummary()
  maybeCatchUp()
  syncDailySend().catch((error) => logger.warn(`[life-diary] 同步每日发送失败：${error?.message ?? error}`))
}

/**
 * 日记本的三个「存放处」：本机文件夹、GitHub 私人仓库、坚果云（WebDAV）。
 *
 * 上层（写碎片、读日记、汇总）只认这一套动作，不关心东西到底存在哪儿：
 *   ensureDir / read / write / list / probe
 *
 * 三种后端的差别都在这儿收口，所以加一种新的存储，只改这个文件。
 *
 * @module dsh-life-diary/storage
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一处失败，带一个统一的代号，上层按代号决定是重试还是报错。 */
export class StorageError extends Error {
  /**
   * @param code - 'not-found' | 'conflict' | 'auth' | 'forbidden' | 'network' | 'unknown'
   * @param message - 给人看的话，不要带凭据。
   * @param status - 原始 HTTP 状态码（本地后端没有）。
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.status = status
  }
}

/** 把多段路径拼成 `a/b/c`，去掉多余的首尾斜杠。 */
export function joinPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

/** HTTP 状态码 → 统一代号。 */
function codeFromStatus(status) {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 409 || status === 412 || status === 422) return 'conflict'
  if (status >= 500) return 'network'
  return 'unknown'
}

// ---------------------------------------------------------------- 本地文件夹

function localBackend({ root }) {
  const base = root

  return {
    kind: 'local',
    label: '本机文件夹',
    location: base,
    /** 本地不需要授权，没有「通不通」的问题，所以不要求验证。 */
    needsVerification: false,

    async ensureDir(relDir) {
      if (!relDir) return
      await mkdir(join(base, ...relDir.split('/')), { recursive: true })
    },

    async read(relPath) {
      const full = join(base, ...relPath.split('/'))
      try {
        return { exists: true, text: await readFile(full, 'utf8') }
      } catch (error) {
        if (error?.code === 'ENOENT') return { exists: false, text: '' }
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          throw new StorageError('forbidden', `没有权限读写 ${full}`)
        }
        throw new StorageError('unknown', `读取 ${full} 失败：${error?.message ?? error}`)
      }
    },

    async write(relPath, text) {
      const full = join(base, ...relPath.split('/'))
      try {
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, text, 'utf8')
      } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          throw new StorageError('forbidden', `没有权限写入 ${full}`)
        }
        throw new StorageError('unknown', `写入 ${full} 失败：${error?.message ?? error}`)
      }
    },

    async list(relDir) {
      const full = join(base, ...String(relDir ?? '').split('/').filter(Boolean))
      try {
        const entries = await readdir(full, { withFileTypes: true })
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => ({ name: entry.name, path: joinPath(relDir, entry.name) }))
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw new StorageError('unknown', `列举 ${full} 失败：${error?.message ?? error}`)
      }
    },

    /**
     * 原子追加：读全文 → 拼 → 写回。本地没有版本号可比，靠「同一台机器只有一个进程在写」。
     */
    async append(relPath, build) {
      const current = await this.read(relPath)
      const next = build(current.text, current.exists)
      await this.write(relPath, next)
      return next
    },

    async remove(relPath) {
      const full = join(base, ...relPath.split('/'))
      try {
        await unlink(full)
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw new StorageError('unknown', `删除 ${full} 失败：${error?.message ?? error}`)
      }
    },

    async probe() {
      const name = `.dsh-life-diary-probe-${Date.now()}.txt`
      const payload = 'dsh-life-diary probe'
      await this.ensureDir('')
      await this.write(name, payload)
      const back = await this.read(name)
      await this.remove(name)
      if (back.text !== payload) {
        return { ok: false, detail: '写进去了，但读回来的内容不一样。' }
      }
      return { ok: true, detail: `能在这个文件夹里读写：${base}` }
    },
  }
}

// ---------------------------------------------------------------- GitHub

function githubBackend({ repo, branch, token, prefix, timeoutMs }) {
  const api = 'https://api.github.com'

  async function request(path, { method = 'GET', body } = {}) {
    let response
    try {
      response = await fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'dsh-life-diary',
          Accept: 'application/vnd.github+json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new StorageError('network', `连不上 GitHub：${error?.message ?? error}`)
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 200)
      } catch {
        /* 读不出响应体也不影响报错 */
      }
      throw new StorageError(codeFromStatus(response.status), `GitHub 返回 ${response.status}：${detail}`, response.status)
    }
    return response.json()
  }

  /** 仓库内的完整路径（带日记本名称）。 */
  const full = (relPath) => joinPath(prefix, relPath)
  const encode = (path) => path.split('/').map(encodeURIComponent).join('/')

  return {
    kind: 'github',
    label: 'GitHub 私人仓库',
    location: `${repo} · ${branch} · ${prefix || '根目录'}`,
    needsVerification: true,

    async ensureDir() {
      // git 不需要预先建目录
    },

    async read(relPath) {
      try {
        const json = await request(`/repos/${repo}/contents/${encode(full(relPath))}?ref=${encodeURIComponent(branch)}`)
        return { exists: true, text: Buffer.from(json.content ?? '', 'base64').toString('utf8') }
      } catch (error) {
        if (error?.code === 'not-found') return { exists: false, text: '' }
        throw error
      }
    },

    async write(relPath, text) {
      const path = full(relPath)
      const body = {
        message: `life-diary: ${relPath}`,
        content: Buffer.from(text, 'utf8').toString('base64'),
        branch,
      }
      // 覆盖要先拿到 sha；冲突时重取一次再写
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let sha
        try {
          const current = await request(`/repos/${repo}/contents/${encode(path)}?ref=${encodeURIComponent(branch)}`)
          sha = current.sha
        } catch (error) {
          if (error?.code !== 'not-found') throw error
        }
        try {
          await request(`/repos/${repo}/contents/${encode(path)}`, {
            method: 'PUT',
            body: sha ? { ...body, sha } : body,
          })
          return
        } catch (error) {
          if (error?.code !== 'conflict' || attempt > 0) throw error
        }
      }
    },

    async list(relDir) {
      const path = full(relDir)
      try {
        const json = await request(`/repos/${repo}/contents/${encode(path)}?ref=${encodeURIComponent(branch)}`)
        if (!Array.isArray(json)) return []
        return json
          .filter((entry) => entry.type === 'file')
          .map((entry) => ({ name: entry.name, path: joinPath(relDir, entry.name) }))
      } catch (error) {
        if (error?.code === 'not-found') return []
        throw error
      }
    },

    /**
     * 原子追加：带着读到的 sha 去写，别人抢先写了就 409，重读重拼再来。
     * 这才是真并发安全——两台机器同时写同一篇不会丢东西。
     */
    async append(relPath, build) {
      const path = full(relPath)
      const encode1 = (p) => p.split('/').map(encodeURIComponent).join('/')
      let text = ''
      let sha
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const current = await request(`/repos/${repo}/contents/${encode1(path)}?ref=${encodeURIComponent(branch)}`)
          text = Buffer.from(current.content ?? '', 'base64').toString('utf8')
          sha = current.sha
        } catch (error) {
          if (error?.code !== 'not-found') throw error
          text = ''
          sha = undefined
        }
        const next = build(text, sha !== undefined)
        const body = {
          message: `life-diary: ${relPath}`,
          content: Buffer.from(next, 'utf8').toString('base64'),
          branch,
        }
        try {
          await request(`/repos/${repo}/contents/${encode1(path)}`, {
            method: 'PUT',
            body: sha ? { ...body, sha } : body,
          })
          return next
        } catch (error) {
          if (error?.code !== 'conflict' || attempt === 2) throw error
        }
      }
      throw new StorageError('conflict', '连试三次都被人抢先写了，放弃这次追加。')
    },

    async remove(relPath) {
      const path = full(relPath)
      const current = await request(`/repos/${repo}/contents/${encode(path)}?ref=${encodeURIComponent(branch)}`)
      await request(`/repos/${repo}/contents/${encode(path)}`, {
        method: 'DELETE',
        body: { message: `life-diary: 删除 ${relPath}`, sha: current.sha, branch },
      })
    },

    async probe() {
      // 日记是私人的：公开仓库一律不放行，这是硬拦，不是提醒。
      let meta
      try {
        meta = await request(`/repos/${repo}`)
      } catch (error) {
        if (error?.code === 'auth') return { ok: false, detail: '令牌无效，或者没有访问这个仓库的权限。' }
        if (error?.code === 'not-found') return { ok: false, detail: '找不到这个仓库。名字对吗？是不是还没建？' }
        return { ok: false, detail: error?.message ?? String(error) }
      }
      if (meta.private !== true) {
        return {
          ok: false,
          detail: '这个仓库是公开的。日记会被人看到，所以只能存进私人仓库——请去仓库设置里改成 Private。',
        }
      }

      const name = `.dsh-life-diary-probe-${Date.now()}.txt`
      const payload = 'dsh-life-diary probe'
      try {
        await this.write(name, payload)
        const back = await this.read(name)
        await this.remove(name)
        if (back.text !== payload) return { ok: false, detail: '写进去了，但读回来的内容不一样。' }
        return { ok: true, detail: `能在这个私人仓库里读写：${repo}` }
      } catch (error) {
        if (error?.code === 'forbidden') {
          return { ok: false, detail: '令牌没有写入权限（需要 Contents: Read and write）。' }
        }
        return { ok: false, detail: error?.message ?? String(error) }
      }
    },
  }
}

// ---------------------------------------------------------------- WebDAV（坚果云等）

/** 从 PROPFIND 的 XML 里挖出文件条目，够用就行，不引 XML 库。 */
function parsePropfind(xml, basePath) {
  const out = []
  const blocks = String(xml).match(/<d:response>[\s\S]*?<\/d:response>/gi) ?? []
  for (const block of blocks) {
    const href = /<d:href>([\s\S]*?)<\/d:href>/i.exec(block)?.[1]
    if (!href) continue
    const decoded = decodeURIComponent(href)
    const isDir = /<d:collection\s*\/>/i.test(block)
    if (isDir) continue
    const trimmed = decoded.replace(/\/+$/, '')
    if (trimmed === basePath.replace(/\/+$/, '')) continue
    const name = trimmed.split('/').filter(Boolean).pop() ?? ''
    out.push({ name, path: joinPath(basePath, name) })
  }
  return out
}

function webdavBackend({ url, user, password, prefix, timeoutMs }) {
  const base = String(url).replace(/\/+$/, '')
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

  async function request(method, path, { body, headers = {} } = {}) {
    const full = `${base}/${joinPath(prefix, path)}`.replace(/([^:])\/{2,}/g, '$1/')
    let response
    try {
      response = await fetch(full, {
        method,
        headers: { Authorization: auth, ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new StorageError('network', `连不上网盘：${error?.message ?? error}`)
    }
    if (!response.ok && response.status !== 405) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 200)
      } catch {
        /* ignore */
      }
      throw new StorageError(codeFromStatus(response.status), `网盘返回 ${response.status}：${detail}`, response.status)
    }
    return response
  }

  return {
    kind: 'webdav',
    label: '坚果云 / WebDAV',
    location: `${base} · ${prefix || '根目录'}`,
    needsVerification: true,

    async ensureDir(relDir) {
      const parts = joinPath(prefix, relDir).split('/').filter(Boolean)
      let sofar = ''
      for (const part of parts) {
        sofar = joinPath(sofar, part)
        const response = await fetch(`${base}/${sofar}`, {
          method: 'MKCOL',
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(timeoutMs),
        })
        // 201 新建成功；405 已存在——两种都算好
        if (!response.ok && response.status !== 405) {
          throw new StorageError(codeFromStatus(response.status), `建文件夹失败：${response.status}`, response.status)
        }
      }
    },

    async read(relPath) {
      const full = `${base}/${joinPath(prefix, relPath)}`
      let response
      try {
        response = await fetch(full, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new StorageError('network', `连不上网盘：${error?.message ?? error}`)
      }
      if (response.status === 404) return { exists: false, text: '', etag: undefined }
      if (!response.ok) {
        throw new StorageError(codeFromStatus(response.status), `读取失败：${response.status}`, response.status)
      }
      return { exists: true, text: await response.text(), etag: response.headers.get('etag') ?? undefined }
    },

    async write(relPath, text) {
      await request('PUT', relPath, {
        body: text,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      })
    },

    async list(relDir) {
      const response = await request('PROPFIND', relDir, { headers: { Depth: '1' } })
      return parsePropfind(await response.text(), joinPath(prefix, relDir))
    },

    /**
     * 原子追加：带上 If-Match（读到的版本号）去写，别人抢先写了就 412，重读重拼再来。
     * 坚果云实测支持这个语义（拿旧版本号写会被 412 挡住）。
     */
    async append(relPath, build) {
      const full = `${base}/${joinPath(prefix, relPath)}`
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await this.read(relPath)
        const next = build(current.text, current.exists)
        const headers = { Authorization: auth, 'Content-Type': 'text/markdown; charset=utf-8' }
        if (current.exists) {
          if (!current.etag) {
            // 服务器没给版本号，就没法保证不撞；照写，但如实说出去
            headers['If-Match'] = '*'
          } else {
            headers['If-Match'] = current.etag
          }
        } else {
          headers['If-None-Match'] = '*'
        }
        let response
        try {
          response = await fetch(full, { method: 'PUT', headers, body: next, signal: AbortSignal.timeout(timeoutMs) })
        } catch (error) {
          throw new StorageError('network', `连不上网盘：${error?.message ?? error}`)
        }
        if (response.ok) return next
        if (response.status === 412 || response.status === 409) continue
        throw new StorageError(codeFromStatus(response.status), `写入失败：${response.status}`, response.status)
      }
      throw new StorageError('conflict', '连试三次都被人抢先写了，放弃这次追加。')
    },

    async remove(relPath) {
      const full = `${base}/${joinPath(prefix, relPath)}`
      const response = await fetch(full, {
        method: 'DELETE',
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok || response.status === 404) return
      throw new StorageError(codeFromStatus(response.status), `删除失败：${response.status}`, response.status)
    },

    async probe() {
      const name = `.dsh-life-diary-probe-${Date.now()}.txt`
      const payload = 'dsh-life-diary probe'
      try {
        await this.ensureDir('')
        await this.write(name, payload)
        const back = await this.read(name)
        await this.remove(name)
        if (back.text !== payload) return { ok: false, detail: '写进去了，但读回来的内容不一样。' }
        return { ok: true, detail: `能在这块网盘里读写：${base}` }
      } catch (error) {
        if (error?.code === 'auth' || error?.code === 'forbidden') {
          return { ok: false, detail: '账号或应用密码不对，或者这个账号没有 WebDAV 权限。' }
        }
        return { ok: false, detail: error?.message ?? String(error) }
      }
    },
  }
}

// ---------------------------------------------------------------- 对外

/**
 * 按配置造一个存储后端。
 * @param storage - `{ kind, local: {path}, github: {repo,branch,token}, webdav: {url,user,password}, name }`
 * @param options - `{ timeoutMs }`
 * @returns 三个后端之一，动作一致。
 */
export function createStorage(storage, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000
  const kind = storage?.kind ?? 'local'
  const prefix = storage?.name ?? ''

  if (kind === 'local') {
    // 本地路径必须用 node:path 的 join：joinPath 会把开头的 `/` 削掉，
    // 那样绝对路径会变成相对路径，东西就写到工作目录里去了。
    const basePath = String(storage?.local?.path ?? '').trim()
    if (!basePath) throw new StorageError('unknown', '本地存储没有配路径。')
    return localBackend({ root: prefix ? join(basePath, prefix) : basePath })
  }
  if (kind === 'github') {
    const repo = String(storage?.github?.repo ?? '').trim()
    if (!repo) throw new StorageError('unknown', 'GitHub 存储没有配仓库。')
    return githubBackend({
      repo,
      branch: storage?.github?.branch || 'main',
      token: storage?.github?.token ?? '',
      prefix,
      timeoutMs,
    })
  }
  if (kind === 'webdav') {
    const url = String(storage?.webdav?.url ?? '').trim()
    if (!url) throw new StorageError('unknown', 'WebDAV 存储没有配地址。')
    return webdavBackend({
      url,
      user: storage?.webdav?.user ?? '',
      password: storage?.webdav?.password ?? '',
      prefix,
      timeoutMs,
    })
  }
  throw new StorageError('unknown', `不认识的存储类型：${kind}`)
}

/** 让界面知道有哪几种可选。 */
export const STORAGE_KINDS = [
  { kind: 'local', label: '本机文件夹', hint: '不用配置，装完就能用。只有这台机器能看。' },
  { kind: 'github', label: 'GitHub 私人仓库', hint: '要建私人仓库 + 生成令牌。需要多端互通时选它。' },
  { kind: 'webdav', label: '坚果云 / WebDAV', hint: '在手机 App 里生成一个应用密码就行。需要多端互通时选它。' },
]

/**
 * 插件的设置：存在哪、怎么读写。
 *
 * 一条重要的分界：**设置永远存在本机**，不跟着日记走。
 * 因为里面可能有 GitHub 令牌、网盘应用密码——把密钥扔进日记的存储位置（尤其是一个
 * 云端仓库）是绝对不能做的事。
 *
 * 所以设置放在 `<dsh 数据目录>/life-diary/<这台机器>/settings.json`，日记可能在
 * 别处（本机别处、GitHub、坚果云），两者互不干扰。
 *
 * @module dsh-life-diary/settings
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 设置文件的位置。 */
export function settingsFile(baseDir) {
  return join(baseDir, 'settings.json')
}

/**
 * 同步读设置。启动时用——插件加载是同步的，等不了异步。
 * @param path - 设置文件路径。
 * @returns 解析后的对象；文件不存在或坏了都返回 undefined（当作没配过）。
 */
export function readSettingsSync(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 写设置。权限固定 600——里面有令牌，不能让同机的其他用户读到。
 * @param path - 设置文件路径。
 * @param value - 要保存的对象（会被完整序列化）。
 */
export async function writeSettings(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * 深合并两层设置：后面的盖前面的。只认普通对象，数组整体替换。
 * @param base - 底（来自 patch 的配置或默认值）。
 * @param over - 盖上去的（来自用户保存的设置）。
 */
export function mergeSettings(base, over) {
  if (!over || typeof over !== 'object') return base
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue
    const current = out[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = mergeSettings(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** 交给前端的设置——**密钥只报「有没有」，不报内容**。 */
export function redactForClient(config) {
  const copy = JSON.parse(JSON.stringify(config ?? {}))
  const github = copy?.storage?.github
  if (github) {
    github.hasToken = Boolean(String(github.token ?? '').trim())
    github.token = ''
  }
  const webdav = copy?.storage?.webdav
  if (webdav) {
    webdav.hasPassword = Boolean(String(webdav.password ?? '').trim())
    webdav.password = ''
  }
  return copy
}

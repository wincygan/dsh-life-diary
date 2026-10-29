/**
 * 日记本名称的规矩。
 *
 * 这个名字会变成文件夹名（本地）、仓库里的目录名（GitHub），或者网盘里的目录名
 * （WebDAV）。三处规则得一致，不然本地能建、云端建不了，用户会莫名其妙。
 *
 * 中文可以。要拦的只有 Windows 上不允许的那几个字符，和首尾的点、空格。
 *
 * @module dsh-life-diary/naming
 */

/** Windows / macOS / Linux 都不接受的字符。 */
const ILLEGAL = /[\\/:*?"<>|]/g

/** 控制字符（含换行、制表）会把路径搞坏。 */
const CONTROL = /[\u0000-\u001f\u007f]/

/** 名字太长会在某些系统上撞到路径长度上限。 */
const MAX_LENGTH = 64

/**
 * 校验用户起的日记本名称。
 * @param input - 用户输入。
 * @returns `{ ok: true, value }` 或 `{ ok: false, reason }`（reason 直接给用户看）。
 */
export function validateDiaryName(input) {
  const raw = typeof input === 'string' ? input : ''
  const name = raw.trim()

  if (!name) return { ok: false, reason: '日记本名称不能空着。' }
  if (name.length > MAX_LENGTH) return { ok: false, reason: `太长了，最多 ${MAX_LENGTH} 个字。` }
  if (ILLEGAL.test(name)) {
    return { ok: false, reason: '不能包含这几个字符：\\ / : * ? " < > |' }
  }
  if (CONTROL.test(name)) return { ok: false, reason: '不能包含换行或制表符。' }
  if (name === '.' || name === '..') return { ok: false, reason: '这个名字不能用。' }
  if (/[. ]$/.test(name)) return { ok: false, reason: '结尾不能是空格或点（Windows 上会出问题）。' }

  return { ok: true, value: name }
}

/**
 * 名称不合法时给一个能用的建议。
 * @param input - 用户输入。
 * @returns 去掉非法字符后的建议名，可能为空串。
 */
export function suggestDiaryName(input) {
  return String(input ?? '')
    .replace(ILLEGAL, '')
    .replace(CONTROL, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_LENGTH)
}

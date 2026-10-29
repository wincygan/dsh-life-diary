/**
 * 日记本身：放在哪儿、长什么样、怎么追加、怎么按范围读回来。
 *
 * 这一层不认识「本地 / GitHub / 坚果云」，它只跟 storage 说那五句话。
 *
 * @module dsh-life-diary/diary
 */

/** 自己那本，和给他的那本，各一个子目录。 */
export const ME_DIR = 'me'
export const OWNER_DIR = 'owner'

/** 文件名一律 `YYYY-MM-DD.md`——排序天然就是时间顺序，不用再按年月分子目录。 */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/

/** 自己那本的文件路径。 */
export function mePath(day) {
  return `${ME_DIR}/${day}.md`
}

/** 给他的那本的文件路径。 */
export function ownerPath(day) {
  return `${OWNER_DIR}/${day}.md`
}

/** 自己那本的表头，只在新建当天文件时写一次。 */
export function meHeader(day) {
  return `# ${day} · 自己那本\n\n> 随手记。碎片也行，一句话也行，不求完整。\n`
}

/** 给他的那本的表头。 */
export function ownerHeader(day) {
  return `# ${day} · 给他的那本\n\n> 从「自己那本」里挑出来整理的。\n\n`
}

/**
 * 判断一本日记里有没有「正文」——去掉标题行、引用行和空行之后，还剩没剩一条像样的内容。
 * 只剩表头的那本按空的算，所以不会拿一页空壳去汇总。
 *
 * 阈值按「有没有一句话」算，不按总字数算：一天只留了一条短碎片，那也是写过日记的一天。
 */
export function hasContent(text) {
  const body = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('>'))
  return body.some((line) => line.replace(/^[-*·\d.]+\s*/, '').length >= 4)
}

/**
 * 往当天「自己那本」追加一段。
 *
 * 写入是「读全文 → 拼接 → 覆盖」，所以并发写同一天会互相盖掉。冲突时重取一次再写，
 * 覆盖那种偶发的撞车；真正的防线是「同一个位置只让一台机器写」。
 *
 * @param storage - 存储后端。
 * @param day - `YYYY-MM-DD`。
 * @param block - 要追加的那一段（已含 `## HH:MM` 小标题）。
 * @returns 写入的文件路径。
 */
export async function appendToMe(storage, day, block) {
  const path = mePath(day)
  await storage.ensureDir(ME_DIR)
  // 交给存储层做「读—拼—写」一个原子动作：中间被人抢先写了会重读重来，不会把对方那句盖掉
  await storage.append(path, (text, exists) => {
    const base = exists ? text : meHeader(day)
    return `${base.replace(/\s+$/, '')}\n\n${block.replace(/\s+$/, '')}\n`
  })
  return path
}

/**
 * 写「给他的那本」——整篇覆盖，因为它是从「自己那本」重新汇总出来的。
 */
export async function writeOwner(storage, day, body) {
  const path = ownerPath(day)
  await storage.ensureDir(OWNER_DIR)
  await storage.write(path, `${ownerHeader(day)}${String(body).replace(/\s+$/, '')}\n`)
  return path
}

/**
 * 在某个范围里，找出「自己那本」实际存在的日子。
 *
 * 先列一次目录再挑，而不是逐天去试读——三十天就是三十次请求，在网盘上很容易撞限额。
 *
 * @param storage - 存储后端。
 * @param range - `{ from, to }`，两端都含。
 * @returns 升序的日期键数组。
 */
export async function listDaysInRange(storage, range, dir = ME_DIR) {
  const from = String(range?.from ?? '')
  const to = String(range?.to ?? '')
  const entries = await storage.list(dir === OWNER_DIR ? OWNER_DIR : ME_DIR)
  const days = []
  for (const entry of entries) {
    const match = DAY_FILE.exec(entry.name)
    if (!match) continue
    const day = match[1]
    if (from && day < from) continue
    if (to && day > to) continue
    days.push(day)
  }
  days.sort()
  return days
}

/**
 * 把某个范围的日记拼成一份。
 *
 * 只读 `me`——`owner` 是从它汇总出来的二手，细节已经丢过一轮。
 *
 * @param storage - 存储后端。
 * @param range - `{ from, to }`。
 * @returns `{ days, count, text }`；一篇都没找到时 `count` 为 0、`text` 为空串。
 */
export async function readRange(storage, range, kind = 'me') {
  const dir = kind === 'owner' ? OWNER_DIR : ME_DIR
  const days = await listDaysInRange(storage, range, dir)
  const chunks = []
  for (const day of days) {
    const file = await storage.read(kind === 'owner' ? ownerPath(day) : mePath(day))
    if (!file.exists) continue
    const body = file.text.trim()
    if (!hasContent(body)) continue
    chunks.push(body)
  }
  return { days, count: chunks.length, text: chunks.join('\n\n---\n\n'), kind }
}

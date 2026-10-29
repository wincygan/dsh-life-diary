/**
 * 日期与换日时刻。
 *
 * 一条硬规矩：**时间一律按用户所在时区算，绝不跟服务器走。**
 * 云端容器常常跑在 UTC，和用户差好几个小时；照服务器算，日记的日期会写歪，
 * 而且不会报错——这种错最难发现。
 *
 * 时区从哪来：先看用户有没有自己填；没填就用这台机器的；再不行退到 UTC。
 * 猜错了用户能改，这一点写在设置里。
 *
 * @module dsh-life-diary/clock
 */

/**
 * 定下要用哪个时区。
 * @param configured - 用户填的时区（IANA 名，如 `Asia/Shanghai`）；空表示交给自动判断。
 * @returns 一个能用的时区名。填了但不合法时，退回本机时区。
 */
export function resolveTimeZone(configured) {
  const candidate = String(configured ?? '').trim()
  if (candidate) {
    try {
      // 直接试一次，不合法会抛
      new Intl.DateTimeFormat('en-CA', { timeZone: candidate })
      return candidate
    } catch {
      /* 填错了，退回自动判断 */
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 目标时区此刻的墙钟读数。
 * @param timeZone - IANA 时区名。
 * @returns `{ year, month, day, hour, minute, second }`，除 year 外都补零。
 */
function wallClock(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  // 个别环境下午夜会给 24 而不是 00
  const hour = String(Number(pick('hour')) % 24).padStart(2, '0')
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour,
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** 今天：`YYYY-MM-DD`。 */
export function dayKey(timeZone) {
  const wall = wallClock(timeZone)
  return `${wall.year}-${wall.month}-${wall.day}`
}

/** 此刻：`HH:MM`。 */
export function timeKey(timeZone) {
  const wall = wallClock(timeZone)
  return `${wall.hour}:${wall.minute}`
}

/**
 * 往前数若干天的日期键。跨月跨年都对，因为走的是 UTC 日期算术。
 * @param timeZone - IANA 时区名。
 * @param days - 往前几天；1 就是昨天。
 */
export function dayKeyOffset(timeZone, days) {
  const wall = wallClock(timeZone)
  const date = new Date(Date.UTC(Number(wall.year), Number(wall.month) - 1, Number(wall.day)))
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

/** 昨天：`YYYY-MM-DD`。 */
export function previousDayKey(timeZone) {
  return dayKeyOffset(timeZone, 1)
}

/**
 * 从今天往回数 n 天，返回起止日期键（含两端）。
 * @param timeZone - IANA 时区名。
 * @param days - 天数。
 * @returns `{ from, to, days }`。
 */
export function recentRange(timeZone, days) {
  const count = Math.max(1, Math.floor(Number(days) || 7))
  return { from: dayKeyOffset(timeZone, count - 1), to: dayKey(timeZone), days: count }
}

/**
 * 某年某月的起止日期键。
 * @param year - 四位年份。
 * @param month - 1 到 12。
 * @returns `{ from, to, days }`。
 */
export function monthRange(year, month) {
  const y = Number(year)
  const m = Number(month)
  if (!Number.isInteger(y) || y < 1970 || y > 9999 || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`年月不合法：${year}-${month}`)
  }
  const pad = (value) => String(value).padStart(2, '0')
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysInMonth)}`, days: daysInMonth }
}

/**
 * 距离下一个 `HH:MM`（目标时区）还有多少毫秒。
 * 正好落在同一分钟时按明天算，避免刚算完就立刻触发。
 */
export function nextFireDelay(timeZone, at) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim())
  if (!match) throw new Error(`时间要写成 HH:MM，收到「${at}」`)
  const targetMinutes = (Number(match[1]) % 24) * 60 + (Number(match[2]) % 60)
  const wall = wallClock(timeZone)
  const nowMinutes = Number(wall.hour) * 60 + Number(wall.minute)
  let delta = targetMinutes - nowMinutes
  if (delta <= 0) delta += 1440
  return Math.max(1000, delta * 60000 - Number(wall.second) * 1000)
}

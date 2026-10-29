// dsh-life-diary — 客户端半边：设置页。
//
// 纯 JavaScript，没有 JSX、没有 ESM import；React 由 ModuleLoader 注入。
// 界面只负责「填 → 验 → 存」，真正的读写全在宿主那半边。
window.__ModuleLoader__.load({
  id: 'dsh-life-diary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var name = 'dsh-life-diary'
    var inject = ['slots']

    var STATE_URL = '/dsh-life-diary/state'
    var VERIFY_URL = '/dsh-life-diary/verify'
    var SAVE_URL = '/dsh-life-diary/save'
    var READ_URL = '/dsh-life-diary/read'
    var SESSIONS_URL = '/dsh-life-diary/sessions'
    var STYLE_ID = 'dsh-life-diary-style'

    var ZONES = [
      ['Asia/Shanghai', '北京 / 上海'],
      ['Asia/Hong_Kong', '香港'],
      ['Asia/Taipei', '台北'],
      ['Asia/Tokyo', '东京'],
      ['Asia/Singapore', '新加坡'],
      ['Europe/London', '伦敦'],
      ['Europe/Berlin', '柏林'],
      ['America/New_York', '纽约'],
      ['America/Los_Angeles', '洛杉矶'],
      ['UTC', 'UTC（协调世界时）'],
    ]

    // 颜色全部走 DSH 的主题变量，皮肤换成什么样它就跟着什么样
    var CSS = [
      '.ld-root{max-width:720px;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit)}',
      '.ld-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:10px;padding:14px 16px;margin:0 0 14px;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.ld-card h3{margin:0 0 10px;font-size:15px;font-weight:600}',
      '.ld-row{display:flex;gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap}',
      '.ld-row label{min-width:96px;opacity:.8}',
      '.ld-grid2{display:grid;grid-template-columns:max-content minmax(110px,1fr) max-content minmax(110px,1fr);gap:8px 12px;align-items:center;margin:8px 0}',
      '.ld-grid2>label{opacity:.8;white-space:nowrap;margin:0}',
      '.ld-grid2>.ld-input{min-width:0;max-width:260px}',
      '.ld-input{flex:1;min-width:200px;padding:6px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:var(--dsw-alias-bg-base,transparent);color:inherit;font-size:14px}',
      '.ld-btn{padding:6px 14px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.42));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));color:inherit;cursor:pointer;font-size:14px}',
      '.ld-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,rgba(128,128,128,.6))}',
      '.ld-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.ld-btn-primary{background:var(--dsw-alias-brand-primary,#3b6fd4);border-color:var(--dsw-alias-brand-primary,#3b6fd4);color:#fff}',
      '.ld-warn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,#e6a028) 14%, transparent);border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary,#e6a028) 45%, transparent);border-radius:8px;padding:9px 12px;margin:10px 0}',
      '.ld-ok{color:var(--dsw-alias-state-success-primary,#2e9e5b)}',
      '.ld-bad{color:var(--dsw-alias-state-error-primary,#cf4b4b)}',
      '.ld-hint{opacity:.65;font-size:13px;margin:6px 0 0}',
      '.ld-tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}',
      '.ld-steps{font-size:13px;opacity:.8;margin:8px 0 0;padding-left:18px}',
      '.ld-modal{position:fixed;inset:0;background:rgba(30,22,40,.32);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:9999}',
      '.ld-modal-box{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,inherit);max-width:640px;max-height:80vh;overflow:auto;border-radius:12px;padding:20px 24px;box-shadow:0 12px 40px rgba(0,0,0,.22);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}',
      '.ld-h{margin:16px 0 6px;font-size:14px;font-weight:600}',
      '.ld-h3{margin:0 0 10px;font-size:15px;font-weight:600}',
      '.ld-title{font-size:18px;font-weight:600;margin:0 0 4px}',
      '.ld-modal-box p,.ld-modal-box li{font-size:13px;line-height:1.7;margin:4px 0}',
      '.ld-pre{max-height:220px;overflow:auto;white-space:pre-wrap;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));border-radius:8px;padding:10px;font-size:13px;margin:10px 0 0}',
    ].join('')

    function mountStyle() {
      if (typeof document === 'undefined') return
      var el = document.getElementById(STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = STYLE_ID
        document.head.appendChild(el)
      }
      // 每次都写一遍：重启容器但没刷新页面时，旧样式会一直赖着不走
      if (el.textContent !== CSS) el.textContent = CSS
    }

    function fetchJson(url, options) {
      return fetch(url, options).then(function (response) {
        return response.json().then(function (body) {
          return body
        })
      })
    }

    function postJson(url, payload) {
      return fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value))
    }

    function SettingsPage() {
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]

      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]

      var verifyState = React.useState(null)
      var verified = verifyState[0]
      var setVerified = verifyState[1]

      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]

      var noteState = React.useState(null)
      var note = noteState[0]
      var setNote = noteState[1]

      var sessionsState = React.useState([])
      var sessions = sessionsState[0]
      var setSessions = sessionsState[1]

      var groupsState = React.useState([])
      var sessionGroups = groupsState[0]
      var setSessionGroups = groupsState[1]

      var helpState = React.useState(false)
      var helpOpen = helpState[0]
      var setHelpOpen = helpState[1]

      var sessionFilterState = React.useState('')
      var sessionFilter = sessionFilterState[0]
      var setSessionFilter = sessionFilterState[1]

      var zoneOtherState = React.useState('')
      var zoneOther = zoneOtherState[0]
      var setZoneOther = zoneOtherState[1]

      var readState = React.useState({ range: '7d', year: 2026, month: 10, result: null })
      var read = readState[0]
      var setRead = readState[1]

      React.useEffect(function () {
        mountStyle()
        fetchJson(STATE_URL)
          .then(function (body) {
            if (!body || !body.ok) throw new Error((body && body.error) || '读不到设置')
            setData(body)
            setDraft(clone(body.settings))
            if (body.resolvedTimeZone) {
              var known = ZONES.some(function (pair) { return pair[0] === body.resolvedTimeZone })
              if (!known) setZoneOther(body.resolvedTimeZone)
            }
          })
          .catch(function (error) {
            setNote({ ok: false, text: String(error.message || error) })
          })
      }, [])

      function reloadSessions() {
        return fetchJson(SESSIONS_URL)
          .then(function (body) {
            if (body && body.ok) {
              if (Array.isArray(body.sessions)) setSessions(body.sessions)
              if (Array.isArray(body.groups)) setSessionGroups(body.groups)
            }
          })
          .catch(function () { /* 列不出来就先空着 */ })
      }

      React.useEffect(function () {
        reloadSessions()
      }, [])

      // 任何一处改动，之前的验证结果立刻作废——不然门禁就是个装饰
      function change(mutator) {
        setDraft(function (current) {
          if (!current) return current
          var next = clone(current)
          mutator(next)
          return next
        })
        setVerified(null)
        setNote(null)
      }

      function updateStorage(path, value) {
        change(function (next) {
          var parts = path.split('.')
          var cursor = next.storage || (next.storage = {})
          for (var i = 0; i < parts.length - 1; i += 1) {
            if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {}
            cursor = cursor[parts[i]]
          }
          cursor[parts[parts.length - 1]] = value
        })
      }

      function doVerify() {
        if (!draft || busy) return
        setBusy('verify')
        setNote(null)
        postJson(VERIFY_URL, draft)
          .then(function (body) {
            setVerified(body)
            setNote({ ok: !!body.ok, text: body.detail || body.error || '' })
          })
          .catch(function (error) {
            setVerified({ ok: false, detail: String(error.message || error) })
            setNote({ ok: false, text: String(error.message || error) })
          })
          .then(function () { setBusy('') })
      }

      function doSave() {
        if (!draft || busy) return
        if (needsVerify && !(verified && verified.ok)) return
        setBusy('save')
        postJson(SAVE_URL, draft)
          .then(function (body) {
            if (!body.ok) {
              setNote({ ok: false, text: body.error || '保存失败' })
              return
            }
            setNote({ ok: true, text: '已保存并生效，不用重启。' })
            setData(function (prev) {
              if (!prev) return prev
              var next = clone(prev)
              next.settings = body.settings || next.settings
              next.resolvedTimeZone = body.resolvedTimeZone || next.resolvedTimeZone
              return next
            })
            setDraft(clone(body.settings))
            setVerified(null)
          })
          .catch(function (error) {
            setNote({ ok: false, text: String(error.message || error) })
          })
          .then(function () { setBusy('') })
      }

      function doRead() {
        if (busy) return
        setBusy('read')
        var payload = { range: read.range }
        if (read.range === 'month') {
          payload.year = Number(read.year)
          payload.month = Number(read.month)
        }
        postJson(READ_URL, payload)
          .then(function (body) {
            if (!body.ok) {
              setRead(function (prev) {
                var next = clone(prev)
                next.result = { ok: false, text: body.error || '读取失败' }
                return next
              })
              return
            }
            setRead(function (prev) {
              var next = clone(prev)
              next.result = {
                ok: true,
                text: body.count === 0
                  ? '没有找到 ' + body.from + ' 到 ' + body.to + ' 之间的日记。'
                  : '已读取 ' + body.count + ' 篇日记（' + body.from + ' — ' + body.to + '）。',
              }
              return next
            })
          })
          .catch(function (error) {
            setRead(function (prev) {
              var next = clone(prev)
              next.result = { ok: false, text: String(error.message || error) }
              return next
            })
          })
          .then(function () { setBusy('') })
      }

      if (!draft) {
        return h('div', { className: 'ld-root' },
          h('p', { className: 'ld-hint' }, note ? note.text : '正在读取设置……'))
      }

      var storage = draft.storage || {}
      var kind = storage.kind || 'local'
      var needsVerify = kind !== 'local'
      var canSave = !needsVerify || (verified && verified.ok)
      var zoneValue = draft.timeZone || ''
      var knownZone = ZONES.some(function (pair) { return pair[0] === zoneValue })

      function row(labelText, control) {
        return h('div', { className: 'ld-row' }, h('label', null, labelText), control)
      }

      function grid2(labelA, controlA, labelB, controlB) {
        return h('div', { className: 'ld-grid2' },
          h('label', null, labelA), controlA,
          h('label', null, labelB), controlB)
      }

      function pair(labelText, control) {
        return h('div', { className: 'ld-pair' }, h('label', null, labelText), control)
      }

      function input(value, onChange, placeholder, type) {
        return h('input', {
          className: 'ld-input',
          type: type || 'text',
          value: value == null ? '' : value,
          placeholder: placeholder || '',
          onChange: function (event) { onChange(event.target.value) },
        })
      }

      var storageCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '日记存在哪儿'),
        grid2(
          '存储方式',
          h('select', {
            className: 'ld-input',
            value: kind,
            onChange: function (event) { updateStorage('kind', event.target.value) },
          },
            h('option', { value: 'local' }, '本机文件夹'),
            h('option', { value: 'github' }, 'GitHub 私人仓库'),
            h('option', { value: 'webdav' }, '坚果云 / WebDAV')),
          '日记本名称',
          input(storage.name, function (v) { updateStorage('name', v) }, '例如：我的日记')),
        h('p', { className: 'ld-hint' }, '这个名称会变成一层文件夹，用来把几个 agent 的日记分开。'),

        h('div', { className: 'ld-warn' },
          '存在本机 = 只有这一台机器能看。想换台电脑也能翻，就选 GitHub 或坚果云。'),

        kind === 'local'
          ? h('div', null,
              row('文件夹', input(storage.local && storage.local.path, function (v) { updateStorage('local.path', v) }, '留空 = 自动放在 dsh 数据目录下')),
              data && data.baseDir
                ? h('p', { className: 'ld-hint' }, '默认位置：' + data.baseDir + '/' + ((storage.name || 'diary')))
                : null)
          : null,

        kind === 'github'
          ? h('div', null,
              row('仓库', input(storage.github && storage.github.repo, function (v) { updateStorage('github.repo', v) }, 'owner/repo')),
              row('分支', input(storage.github && storage.github.branch, function (v) { updateStorage('github.branch', v) }, 'main')),
              row('令牌', input('', function (v) { updateStorage('github.token', v) },
                storage.github && storage.github.hasToken ? '已保存（留空则不修改）' : '粘贴 GitHub 令牌', 'password')),
              h('ol', { className: 'ld-steps' },
                h('li', null, '在 GitHub 建一个仓库，选 Private（公开仓库会被拒绝——日记不能给人看）。'),
                h('li', null, '头像 → Settings → Developer settings → Personal access tokens → 生成细颗粒度令牌，只授权这个仓库的 Contents 读写。'),
                h('li', null, '把令牌粘到上面，点「试写一篇」验证。')))
          : null,

        kind === 'webdav'
          ? h('div', null,
              row('地址', input(storage.webdav && storage.webdav.url, function (v) { updateStorage('webdav.url', v) }, 'https://dav.jianguoyun.com/dav/')),
              row('账号', input(storage.webdav && storage.webdav.user, function (v) { updateStorage('webdav.user', v) }, '你的登录邮箱')),
              row('应用密码', input('', function (v) { updateStorage('webdav.password', v) },
                storage.webdav && storage.webdav.hasPassword ? '已保存（留空则不修改）' : '应用密码', 'password')),
              h('ol', { className: 'ld-steps' },
                h('li', null, '打开坚果云 App，进「第三方应用管理」→「添加应用」。'),
                h('li', null, '生成一个应用密码，复制它。'),
                h('li', null, '地址填 https://dav.jianguoyun.com/dav/ ，账号填登录邮箱，密码贴上面那串。')))
          : null)

      var isAutoZone = !zoneValue
      var zoneSelectValue = isAutoZone ? '' : (knownZone ? zoneValue : '__other__')
      var zoneSelect = h('select', {
        className: 'ld-input',
        value: zoneSelectValue,
        onChange: function (event) {
          var value = event.target.value
          if (value === '__other__') {
            change(function (next) { next.timeZone = zoneOther || '' })
            return
          }
          change(function (next) { next.timeZone = value })
        },
      },
        h('option', { value: '' }, '自动判断（' + ((data && data.resolvedTimeZone) || '未知') + '）'),
        ZONES.map(function (zone) { return h('option', { key: zone[0], value: zone[0] }, zone[1] + ' · ' + zone[0]) }),
        h('option', { value: '__other__' }, '其他（自己填）'))

      var timeCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '时间'),
        grid2(
          '时区', zoneSelect,
          '汇总时刻', input(draft.summaryAt, function (v) { change(function (next) { next.summaryAt = v }) }, '07:45')),
        !isAutoZone && !knownZone
          ? h('div', { className: 'ld-row' },
              pair('自定义时区', input(zoneValue, function (v) { setZoneOther(v); change(function (next) { next.timeZone = v }) }, '例如 Asia/Shanghai')))
          : null,
        h('p', { className: 'ld-hint' }, '云服务器常常跑在别的时区，判断错了日记的日期会差几个小时。到汇总时刻，就把前一天「自己那本」整理成「给他的那本」。'))

      var keyword = sessionFilter.trim().toLowerCase()
      var rawGroups = sessionGroups.length ? sessionGroups : [{ title: '会话', sessions: sessions }]
      var visibleGroups = rawGroups
        .map(function (group) {
          return {
            title: group.title,
            sessions: group.sessions.filter(function (item) {
              if (!keyword) return true
              return String(item.label || '').toLowerCase().indexOf(keyword) >= 0
            }),
          }
        })
        .filter(function (group) { return group.sessions.length > 0 })
      var visibleCount = visibleGroups.reduce(function (sum, group) { return sum + group.sessions.length }, 0)

      var send = draft.sendDaily || {}
      var sendCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '每天念给你听'),
        h('label', { className: 'ld-row', style: { cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: send.enabled === true,
            onChange: function (event) {
              var on = event.target.checked
              change(function (next) {
                next.sendDaily = next.sendDaily || {}
                next.sendDaily.enabled = on
                if (on && !next.sendDaily.at) next.sendDaily.at = '07:50'
              })
            },
          }),
          h('span', null, '每天到点，把昨天那篇日记念给我听')),
        h('p', { className: 'ld-hint' },
          '插件自己发不出消息（不知道你用的是微信还是网页），所以它只能挂在下面选的那个对话里开口——早上你在别处忙正事，它不会跑过去砸一大段日记。'),
        visibleCount === 0
          ? h('p', { className: 'ld-hint' }, '（这个部署没给出可选的对话。没关系——去你想收日记的那个对话里说一句「把每日日记挂在这里」就行。）')
          : null,
        send.enabled
          ? h('div', null,
              row('挂在哪个对话',
                h('div', { style: { display: 'flex', gap: '8px', flex: 1, minWidth: 0 } },
                h('input', {
                  className: 'ld-input',
                  style: { maxWidth: '150px' },
                  value: sessionFilter,
                  placeholder: '搜名字',
                  onChange: function (event) { setSessionFilter(event.target.value) },
                }),
                h('select', {
                  className: 'ld-input',
                  value: send.sessionId || '',
                  onFocus: function () { reloadSessions() },
                  onMouseDown: function () { reloadSessions() },
                  onChange: function (event) {
                    var value = event.target.value
                    change(function (next) { next.sendDaily.sessionId = value })
                  },
                },
                  h('option', { value: '' }, '（请选择一个对话）'),
                  visibleGroups.map(function (group) {
                    return h('optgroup', { key: group.title, label: group.title },
                      group.sessions.map(function (item) {
                        return h('option', { key: item.id, value: item.id }, item.label)
                      }))
                  }),
                  send.sessionId && !sessions.some(function (item) { return item.id === send.sessionId })
                    ? h('option', { value: send.sessionId }, '（当前已绑定：' + String(send.sessionId).slice(0, 8) + '）')
                    : null))),
              row('几点', input(send.at || '07:50', function (v) { change(function (next) { next.sendDaily.at = v }) }, '07:50')))
          : null,
        h('p', { className: 'ld-hint' },
          '关着也没关系——日记照样写，只是早上不会自动送到你眼前。'))

      var agentReadCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '允许它自己翻日记'),
        h('label', { className: 'ld-row', style: { cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: draft.agentMayRead === true,
            onChange: function (event) {
              var on = event.target.checked
              change(function (next) { next.agentMayRead = on })
            },
          }),
          h('span', null, '让它知道自己有日记可以读')),
        h('p', { className: 'ld-hint' },
          '打开后 agent 可能会自己去翻日记，可能额外产生费用。我们无法保证它一定会翻，也无法保证它一定不翻——什么时候读、读不读，由它自己判断。'),
        h('p', { className: 'ld-hint' },
          '关着也不影响下面的「读一遍」，那是你自己手动触发的。'))

      var verifyCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '验证与保存'),
        needsVerify
          ? h('p', { className: 'ld-hint' }, '选了云端存储，必须先「试写一篇」验证通过，才能保存启用。')
          : h('p', { className: 'ld-hint' }, '存在本机不需要验证，直接保存就能用。'),
        h('div', { className: 'ld-row' },
          needsVerify
            ? h('button', {
                className: 'ld-btn',
                disabled: !!busy || verified !== null,
                onClick: doVerify,
              }, busy === 'verify' ? '正在验证……' : verified ? (verified.ok ? '已通过验证' : '验证失败') : '试写一篇')
            : null,
          h('button', {
            className: 'ld-btn ld-btn-primary',
            disabled: !!busy || !canSave,
            onClick: doSave,
          }, busy === 'save' ? '正在保存……' : '保存并启用')),
        note ? h('p', { className: note.ok ? 'ld-ok' : 'ld-bad' }, note.text) : null,
        needsVerify && !canSave ? h('p', { className: 'ld-hint' }, '验证通过之前，这个按钮点不了。改任何一个设置，验证都要重来。') : null)

      var readCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '读日记'),
        h('p', { className: 'ld-hint' }, '这个按钮是给 agent「回忆」用的：读出来的内容会交给它。平时不用点。'),
        h('div', { className: 'ld-row' },
          h('label', null, '范围'),
          h('select', {
            className: 'ld-input',
            value: read.range,
            onChange: function (event) {
              var value = event.target.value
              setRead(function (prev) { var next = clone(prev); next.range = value; next.result = null; return next })
            },
          },
            h('option', { value: '7d' }, '最近 7 天'),
            h('option', { value: '30d' }, '最近 30 天（会明显更花钱）'),
            h('option', { value: 'month' }, '指定某年某月'))),
        read.range === 'month'
          ? h('div', { className: 'ld-row' },
              h('label', null, '年月'),
              h('select', {
                className: 'ld-input',
                value: String(read.year),
                onChange: function (event) { setRead(function (prev) { var next = clone(prev); next.year = Number(event.target.value); next.result = null; return next }) },
              }, [2024, 2025, 2026, 2027, 2028].map(function (y) { return h('option', { key: y, value: String(y) }, y + ' 年') })),
              h('select', {
                className: 'ld-input',
                value: String(read.month),
                onChange: function (event) { setRead(function (prev) { var next = clone(prev); next.month = Number(event.target.value); next.result = null; return next }) },
              }, [1,2,3,4,5,6,7,8,9,10,11,12].map(function (m) { return h('option', { key: m, value: String(m) }, m + ' 月') })))
          : null,
        read.range !== '7d'
          ? h('p', { className: 'ld-hint' }, '读这么多，内容会一直留在那段对话里，之后每一轮都会多花一点钱。想清掉就开一个新对话。')
          : null,
        h('div', { className: 'ld-row' },
          h('button', { className: 'ld-btn', disabled: !!busy, onClick: doRead },
            busy === 'read' ? '正在读……' : '读一遍')),
        read.result ? h('p', { className: read.result.ok ? 'ld-ok' : 'ld-bad' }, read.result.text) : null)

      var aboutCard = h('div', { className: 'ld-card' },
        h('div', { className: 'ld-h3' }, '这是什么'),
        h('p', null, '一天两本日记。「自己那本」是随手记，一轮对话停下、三分钟没新消息之后自动写一条；「给他的那本」是换日时从自己那本里挑出来整理的。'),
        h('p', null, '日记不会进每一轮的上下文，所以不占你的额度——只有点了「读一遍」，内容才会交到 agent 手上。'),
        h('p', { className: 'ld-hint' }, '两条规矩：自己那本是空的，就不写给他的那本；汇总不是全抄，是挑能说的。'),
        h('div', { className: 'ld-row' },
          h('button', { className: 'ld-btn', onClick: function () { setHelpOpen(true) } }, '使用说明')))

      var helpModal = helpOpen
        ? h('div', { className: 'ld-modal', onClick: function (e) { if (e.target === e.currentTarget) setHelpOpen(false) } },
            h('div', { className: 'ld-modal-box' },
              h('div', { className: 'ld-h3' }, '日记 使用说明'),
              h('div', { className: 'ld-h' }, '它做什么'),
              h('p', null, '一天两本，都是它自己写的。'),
              h('p', null, '「自己那本」（me/）是它的随手记——一轮对话停下、三分钟没新消息之后，它自动写一条碎片。可以糙，可以不完整。'),
              h('p', null, '「给你的那本」（owner/）是换日时它只读自己那本、挑能说的整理出来给你看，不会重读整天对话。'),
              h('div', { className: 'ld-h' }, '日记不占你的额度'),
              h('p', null, '日记不会进每一轮的上下文。只有你点了「读一遍」，内容才会交到它手上。'),
              h('div', { className: 'ld-h' }, '存在哪儿'),
              h('p', null, '三选一：本机文件夹（默认，零配置）、GitHub 私人仓库、坚果云（WebDAV）。'),
              h('p', null, '存本机 = 只有这台机器能看。想换台电脑也能翻，就选云端。GitHub 必须是私人仓库——公开的会被直接拒绝。'),
              h('div', { className: 'ld-h' }, '两条规矩'),
              h('p', null, '一、自己那本是空的，它就不会写给你的那本。不编、不硬凑。'),
              h('p', null, '二、汇总不是全抄，是挑能说的。'),
              h('div', { className: 'ld-h' }, '花多少钱'),
              h('p', null, '写碎片一次用一段独立的小上下文，不重读整天对话；汇总一天一次；手动记一笔不调模型。'),
              h('p', null, '「读一遍」最近 7 天很轻，一整个月会重——读进来的内容会一直留在那段对话里，开新对话才清掉。'),
              h('div', { className: 'ld-h' }, '每日发送'),
              h('p', null, '打开后可以挂到某个对话上，到点由它把昨天那篇念一遍。也可以不用列表——直接在目标对话里说一句「把每日日记挂在这里」。'),
              h('div', { className: 'ld-h' }, '已知边界'),
              h('p', null, '本机存储不会自动同步到别处；同一个位置建议只让一台机器写。'),
              h('p', null, '「读一遍」是给它回忆用的。你想看原文，直接打开文件夹就行。'),
              h('div', { className: 'ld-row', style: { marginTop: '16px' } },
                h('button', { className: 'ld-btn ld-btn-primary', onClick: function () { setHelpOpen(false) } }, '知道了'))))
        : null

      var header = h('div', null,
        h('div', { className: 'ld-row' },
          h('div', { className: 'ld-title' }, (data && data.diaryName) || '日记'),
          data && data.storage && data.storage.label
            ? h('span', { className: 'ld-tag' }, data.storage.label + ' · ' + (data.dayCount || 0) + ' 篇')
            : null),
        data && data.storage && data.storage.location
          ? h('p', { className: 'ld-hint' }, '当前位置：' + data.storage.location)
          : null,
        data && data.storage && data.storage.error
          ? h('p', { className: 'ld-bad' }, '存储有问题：' + data.storage.error)
          : null)

      return h('div', { className: 'ld-root' },
        header, storageCard, timeCard, sendCard, agentReadCard, verifyCard, readCard, aboutCard, helpModal)
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined || React === undefined) return
      mountStyle()
      ctx.effect(function () {
        return slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'life-diary', order: 210, label: '日记' },
            function LifeDiarySettings() {
              return h(SettingsPage)
            },
          )
        })
      }, 'life-diary: settings section')
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

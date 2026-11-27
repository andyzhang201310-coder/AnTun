// 真机验收 1.7.2：Psiphon 出口补齐 + 模式互斥 + 收藏页入口
const http = require('http')

const PORT = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(path) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => res(JSON.parse(b)))
    }).on('error', rej)
  })
}

;(async () => {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page' && t.url.includes('tauri')) || list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq
    pend.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  // 预置：清空 Psiphon 出口地区（上次残留 JP，导致空等两分钟），并回到订阅模式首页
  const seeded = await ev(`(() => {
    const raw = localStorage.getItem('antun-prefs')
    if (!raw) return 'no prefs'
    const box = JSON.parse(raw)
    const st = box.state = box.state || {}
    st.settings = Object.assign({}, st.settings, { psiphonRegion: '', connMode: 'subscription', psiphon: false })
    st.page = 'home'
    localStorage.setItem('antun-prefs', JSON.stringify(box))
    return 'ok'
  })()`)
  console.log(`[0] 预置 ${seeded}（出口地区=自动，模式=订阅）`)
  if (seeded === 'ok') {
    await send('Page.reload')
    await sleep(1800)
  }

  // 关掉首次启动的免责弹窗
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '确定'); if (b) b.click(); return !!b })()`)
  await sleep(400)

  // ===== [1] 订阅模式下 Psiphon 必须禁用 =====
  const subMode = await ev(`(() => {
    const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
    const sw = row?.querySelector('.switch')
    return { found: !!row, disabled: !!sw?.disabled, desc: row?.querySelector('.d')?.textContent || '' }
  })()`)
  console.log(`[1] 订阅模式 Psiphon 开关 found=${subMode.found} disabled=${subMode.disabled}`)
  console.log(`    说明="${subMode.desc}"`)

  // ===== [2] 切到 WARP 模式后应可用 =====
  const switched = await ev(`(async () => {
    const trig = document.querySelector('.flag-trigger')
    if (!trig) return { err: 'no trigger' }
    trig.click()
    await new Promise(r => setTimeout(r, 250))
    const first = document.querySelector('.flag-menu .flag-option')
    const label = first?.textContent || ''
    first?.click()
    await new Promise(r => setTimeout(r, 900))
    const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
    const sw = row?.querySelector('.switch')
    return { picked: label, disabled: !!sw?.disabled, badge: document.querySelector('.home-node-pick-head .badge')?.textContent || '' }
  })()`)
  console.log(`[2] 选中"${switched.picked}" -> 模式=${switched.badge} Psiphon disabled=${switched.disabled}`)

  if (switched.disabled) {
    console.log('RESULT: FAIL（WARP 模式下 Psiphon 仍不可用）')
    ws.close(); process.exitCode = 1; return
  }

  // ===== [3] 打开 Psiphon 并连接 =====
  const on = await ev(`(async () => {
    const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
    const sw = row?.querySelector('.switch')
    if (sw && !sw.classList.contains('on')) {
      sw.click()
      await new Promise(r => setTimeout(r, 350))
    }
    return !!sw?.classList.contains('on')
  })()`)
  console.log(`[3] Psiphon 开关 = ${on}`)

  await ev(`document.querySelector('.connect-ring').click()`)
  console.log('[4] 已点击连接，等待隧道（Psiphon 首次启动要下载服务器列表，最多 200 秒）…')

  const started = Date.now()
  let state = null
  let lastHint = ''
  for (let i = 0; i < 100; i++) {
    await sleep(2000)
    const snap = await ev(`(() => {
      const ring = document.querySelector('.connect-ring')
      const body = document.body.innerText
      const cards = [...document.querySelectorAll('.card')].map(c => c.innerText.replace(/\\n+/g, ' | '))
      const err = [...document.querySelectorAll('.test-msg.bad, .banner, .error, .warn')].map(e => e.innerText).join(' / ')
      return {
        connected: !!ring?.classList.contains('connected'),
        connecting: !!ring?.classList.contains('connected') === false && body.includes('正在连接'),
        psiphonSession: body.includes('Psiphon · 出口'),
        hint: body.includes('正在启动 Psiphon 出口') ? 'psiphon-starting' : '',
        cards: cards.slice(0, 4),
        err,
      }
    })()`)
    const elapsed = Math.round((Date.now() - started) / 1000)
    if (snap.hint && snap.hint !== lastHint) { console.log(`    ${elapsed}s: 正在启动 Psiphon 出口…`); lastHint = snap.hint }
    if (snap.err) console.log(`    ${elapsed}s 错误: ${snap.err.slice(0, 200)}`)
    if (snap.connected) { state = snap; console.log(`   ${elapsed}s: 已连接`); break }
    if (!snap.connecting && elapsed > 20) {
      // 既没连上也不在连接中：大概率失败了，读一次页面错误
      state = snap
      console.log(`   ${elapsed}s: 连接已中止`)
      break
    }
  }

  const cards = (state?.cards || []).join(' || ')
  console.log(`[5] 连接结果 connected=${state?.connected} session=Psiphon? ${state?.psiphonSession}`)
  console.log(`    页面卡片: ${cards.slice(0, 300)}`)

  // ===== [6] 断开并确认进程回收（进程检查在外部完成） =====
  if (state?.connected) {
    await ev(`document.querySelector('.connect-ring').click()`)
    await sleep(3000)
    const after = await ev(`(() => {
      const ring = document.querySelector('.connect-ring')
      return { connected: !!ring?.classList.contains('connected'), body: document.body.innerText.includes('未连接') }
    })()`)
    console.log(`[6] 断开后 connected=${after.connected} 显示未连接=${after.body}`)
  }

  const pass = subMode.disabled && !switched.disabled && state?.connected && state?.psiphonSession
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  ws.close()
  process.exitCode = pass ? 0 : 1
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

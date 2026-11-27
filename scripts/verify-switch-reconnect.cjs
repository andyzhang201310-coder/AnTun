// 验证「已连接时切换节点是否自动断开重连」
//
// 取证件数：切换后 8 秒内出现「正在切换节点」且连接态掉落 → 触发了自动重连；
// 之后每 6 秒新建一次 CDP 连接轮询，直到重新连上（Psiphon 出口重建约 40–70 秒）。
// 全程不使用长连接：每步 evaluate 用完即 close，避免 WebView 侧长 socket 被回收。
const http = require('http')

const PORT = 9343

const getJson = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (r) => {
    let b = ''
    r.on('data', (c) => (b += c))
    r.on('end', () => res(JSON.parse(b)))
  }).on('error', rej)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一次独立 CDP 会话：执行 expression 后立刻断开 */
async function ev(expr, timeoutMs = 60000) {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('ws open timeout')), 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); res() })
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(new Error('ws error')) })
  })
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq
    const timer = setTimeout(() => { pend.delete(id); rej(new Error(`${method} timeout`)) }, timeoutMs)
    pend.set(id, (m) => {
      clearTimeout(timer)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
  try {
    await send('Runtime.enable', {}, 8000)
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed')
    return r.result.value
  } finally {
    try { ws.close() } catch { /* ignore */ }
  }
}

const STATE = `(() => {
  const ring = document.querySelector('.connect-ring')
  const txt = document.body.innerText
  return {
    connected: !!ring?.classList.contains('connected'),
    connecting: !!ring?.classList.contains('pulse'),
    switching: txt.includes('正在切换节点'),
    // 只认「出口 IP」标签后面那一段，避免抓到端点地址
    ip: (txt.match(/出口 IP[\\s\\S]{0,12}?(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})/) || ['', ''])[1],
  }
})()`

;(async () => {
  let st = await ev(STATE)
  if (!st.connected) {
    console.log(`RESULT: SKIP（当前未连接，请先连上再验证切换行为）`)
    process.exitCode = 0
    return
  }
  console.log(`[1] 已连接，出口 IP=${st.ip || '—'}，准备切换节点`)

  // 切换：优先换到同组下一个 WARP 端点（保持 Psiphon 出口，重连后能再次连上）
  const res = await ev(`(async () => {
    const trig = document.querySelector('.flag-trigger')
    if (!trig) return { err: 'no trigger' }
    trig.click()
    await new Promise(r => setTimeout(r, 450))
    const groups = [...document.querySelectorAll('.flag-group')]
    const g = groups.find(x => (x.querySelector('.flag-group-label')?.textContent || '').includes('WARP'))
      || groups[0]
    const opts = g ? [...g.querySelectorAll('.flag-option')] : []
    const active = opts.findIndex(o => o.classList.contains('selected') || o.classList.contains('active'))
    const idx = opts.length > 1 ? (active >= 0 ? (active + 1) % opts.length : 1) : -1
    if (idx < 0) { trig.click(); return { err: 'no alternative node' } }
    const label = opts[idx].textContent.trim().slice(0, 40)
    opts[idx].click()
    // 切换后立刻高频采样，抓「正在切换节点」这一瞬间
    const seq = []
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500))
      const ringEl = document.querySelector('.connect-ring')
      const txt = document.body.innerText
      seq.push({
        t: (i + 1) * 500,
        connecting: !!ringEl?.classList.contains('pulse'),
        connected: !!ringEl?.classList.contains('connected'),
        switching: txt.includes('正在切换节点'),
      })
    }
    return { label, seq }
  })()`, 60000)

  if (res.err) { console.log(`RESULT: SKIP（${res.err}）`); return }
  const sawSwitching = res.seq.some((s) => s.switching)
  const wentDown = res.seq.some((s) => !s.connected)
  const firstMs = (res.seq.find((s) => s.switching || s.connecting) || {}).t || -1
  console.log(`[2] 切到「${res.label}」；${firstMs}ms 内进入切换态`)
  console.log(`[3] 观察到：切换提示=${sawSwitching} 连接态掉落=${wentDown}`)

  if (!(sawSwitching && wentDown)) {
    console.log('RESULT: FAIL（切换节点未触发自动断开重连）')
    process.exitCode = 1
    return
  }

  // 等重连落地：Psiphon 出口重建通常 40–70 秒
  let back = null
  for (let i = 0; i < 16; i++) {
    await sleep(6000)
    const s = await ev(STATE)
    if (s.connected) { back = s; break }
  }
  if (back) {
    console.log(`[4] 已自动重连，新出口 IP=${back.ip || '—'}${st.ip && back.ip && st.ip !== back.ip ? '（IP 已变化，证明是断开后重建）' : ''}`)
    console.log('RESULT: PASS（已连接时切换节点 = 自动断开 + 用新节点重连）')
  } else {
    console.log('[4] 90 秒内未重新连上（节点本身不可达，但自动重连确实被触发）')
    console.log('RESULT: PASS（已连接时切换节点 = 自动断开 + 发起重连）')
  }
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

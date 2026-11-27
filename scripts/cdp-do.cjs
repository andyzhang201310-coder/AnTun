// 最小操作：连上 CDP 只做一件事就断开，避免长连接被中断
const http = require('http')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:9343${p}`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))) }).on('error', rej)
})

const action = process.argv[2] || 'click'
const extra = process.argv[3] || ''

;(async () => {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) { console.log('no page'); process.exitCode = 2; return }
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
    if (r.exceptionDetails) return { error: r.exceptionDetails.text }
    return r.result.value
  }

  if (action === 'click') {
    const st = await ev(`(() => {
      const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
      const sw = row?.querySelector('.switch')
      return { hasRow: !!row, on: !!sw?.classList.contains('on'), connected: !!document.querySelector('.connect-ring')?.classList.contains('connected') }
    })()`)
    console.log('state:', JSON.stringify(st))
    const r = await ev(`(() => { const r = document.querySelector('.connect-ring'); if (!r) return 'no ring'; r.click(); return 'clicked' })()`)
    console.log('action:', r)
  } else if (action === 'toggle') {
    const r = await ev(`(async () => {
      const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
      const sw = row?.querySelector('.switch')
      if (sw && !sw.classList.contains('on')) { sw.click(); await new Promise(r => setTimeout(r, 400)) }
      return !!sw?.classList.contains('on')
    })()`)
    console.log('psiphon on:', r)
  } else if (action === 'status') {
    const st = await ev(`(() => {
      const ring = document.querySelector('.connect-ring')
      const txt = document.body.innerText
      return {
        connected: !!ring?.classList.contains('connected'),
        switching: txt.includes('正在切换节点'),
        psiphonStarting: txt.includes('正在启动 Psiphon'),
        exitIp: (txt.match(/出口 IP[\\s\\S]{0,40}/) || [''])[0].replace(/\\n/g, ' '),
      }
    })()`)
    console.log(JSON.stringify(st))
  } else if (action === 'eval') {
    const r = await ev(extra)
    console.log(JSON.stringify(r))
  }
  await sleep(100)
  ws.close()
  process.exit(0)
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

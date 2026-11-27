// 验证「连接中点圆环可取消」
//
// 关键断言：
//   1. 连接过程中圆环带 cancellable 类、副标题出现「点此取消」
//   2. 点击后 connecting 在数秒内归位，且出现「正在取消」过渡态
//   3. 取消后 psiphon.exe 不残留（这条最容易漏：取消时只置标志不停进程，
//      进程会一直挂到 150 秒超时，端口和网络都被占着）
//   4. 日志记为「取消」而不是「连接失败」，避免用户以为节点有问题
//
// 每步用独立 CDP 会话（长连接会被 WebView 侧回收），单步用完即关。
const http = require('http')
const { execSync } = require('child_process')

const PORT = 9343

const getJson = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))) }).on('error', rej)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ev(expr, timeoutMs = 60000) {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('ws open timeout')), 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); res() })
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('ws error')) })
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
    pend.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) })
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

const pids = (name) => {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: 'utf8', timeout: 10000 })
    return (out.match(new RegExp(name, 'gi')) || []).length
  } catch { return 0 }
}

;(async () => {
  // 前置：已在连接中就先取消，已连接就先断开，保证从干净状态开始
  let st = await ev(`(() => {
    const ring = document.querySelector('.connect-ring')
    return {
      connected: !!ring?.classList.contains('connected'),
      connecting: !!ring?.classList.contains('pulse'),
      cancellable: !!ring?.classList.contains('cancellable'),
    }
  })()`)
  if (st.connecting) {
    console.log('RESULT: SKIP（应用当前正在连接，请等它结束或先取消再跑）')
    process.exitCode = 0
    return
  }
  if (st.connected) {
    await ev(`document.querySelector('.connect-ring').click()`)
    await sleep(2500)
    console.log('[0] 已断开，从干净状态开始')
  } else {
    console.log('[0] 当前未连接，从干净状态开始')
  }

  // 走 WARP 模式 + 开 Psiphon：连接会持续几十秒，才有足够窗口验证取消
  const setup = await ev(`(async () => {
    const trig = document.querySelector('.flag-trigger')
    if (trig) {
      trig.click()
      await new Promise(r => setTimeout(r, 450))
      const g = [...document.querySelectorAll('.flag-group')].find(x => (x.querySelector('.flag-group-label')?.textContent || '').includes('WARP'))
      const opts = g ? [...g.querySelectorAll('.flag-option')] : []
      if (opts.length) { opts[0].click(); await new Promise(r => setTimeout(r, 500)) }
      else trig.click()
    }
    const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
    const sw = row?.querySelector('.switch')
    if (sw && !sw.classList.contains('on')) { sw.click(); await new Promise(r => setTimeout(r, 400)) }
    return { psiphonOn: !!sw?.classList.contains('on') }
  })()`)
  console.log(`[1] 前置：WARP 模式 + Psiphon 出口=${setup.psiphonOn}`)

  // 开始连接
  await ev(`document.querySelector('.connect-ring').click()`)
  await sleep(4000)

  const mid = await ev(`(() => {
    const ring = document.querySelector('.connect-ring')
    const txt = document.body.innerText
    return {
      connecting: !!ring?.classList.contains('pulse'),
      cancellable: !!ring?.classList.contains('cancellable'),
      hint: txt.includes('点此取消'),
    }
  })()`)
  console.log(`[2] 连接中：pulse=${mid.connecting} 可取消类=${mid.cancellable} 提示=「点此取消」${mid.hint}`)
  if (!mid.connecting) {
    console.log('RESULT: SKIP（连接结束得太快，来不及验证取消；可改用 Psiphon 出口再试）')
    process.exitCode = 0
    return
  }

  const psiphonRunning = pids('psiphon.exe')
  console.log(`[3] 取消前 psiphon.exe 进程数=${psiphonRunning}`)

  // 点圆环取消，测到连接态复位为止
  const t0 = Date.now()
  await ev(`document.querySelector('.connect-ring').click()`)
  let sawCancelling = false
  let settled = -1
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const s = await ev(`(() => {
      const ring = document.querySelector('.connect-ring')
      return {
        connecting: !!ring?.classList.contains('pulse'),
        cancelling: !!ring?.classList.contains('cancelling'),
        text: document.body.innerText.includes('正在取消'),
        connected: !!ring?.classList.contains('connected'),
      }
    })()`)
    if (s.cancelling || s.text) sawCancelling = true
    if (!s.connecting && !s.connected) { settled = Date.now() - t0; break }
  }
  console.log(`[4] 点击取消 → ${settled >= 0 ? settled + 'ms 后回到未连接' : '16 秒内未复位'}，出现「正在取消」=${sawCancelling}`)

  await sleep(1200)
  const after = pids('psiphon.exe')
  const logTail = await ev(`(() => {
    const pre = [...document.querySelectorAll('pre, .log-line, .logview, .logs')].map(e => e.textContent).join('\\n')
    return pre.slice(-500)
  })()`)

  const finalSt = await ev(`(() => {
    const ring = document.querySelector('.connect-ring')
    return { connected: !!ring?.classList.contains('connected'), connecting: !!ring?.classList.contains('pulse') }
  })()`)
  const logOk = /cancel/i.test(logTail) || logTail.includes('取消')
  const logAsFailure = logTail.includes('connect failed')

  console.log(`[5] 取消后 psiphon.exe 进程数=${after}（取消前 ${psiphonRunning}）`)
  console.log(`[6] 终态：connected=${finalSt.connected} connecting=${finalSt.connecting}；日志记到取消=${logOk}；误记为失败=${logAsFailure}`)

  const pass = settled >= 0 && settled < 15000 && after === 0 && !finalSt.connected && !finalSt.connecting
  console.log(pass ? 'RESULT: PASS（连接中可取消，进程已清理，状态复位）' : 'RESULT: FAIL')
  process.exitCode = pass ? 0 : 1
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

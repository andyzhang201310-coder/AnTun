/**
 * 1.6.2 验证：健康检查抗抖动 + 自动重连
 *
 * 用桩替代桌面桥接，避免真实拨号，验证：
 * 1) 单次探测失败不再立刻断开（旧版本 1 次失败就清空连接）
 * 2) 连续 3 次失败才判定隧道失效，并自动重连（coreConnect 被再次调用）
 * 3) 核心进程退出（fatal）时立即断开并自动重连
 */
const http = require('http')

const PORT = 9445
const WEB = 'http://localhost:4601/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STUB = `(() => {
  const probe = { calls: 0, queue: [] }
  window.__stub = { probe, connects: 0, stops: 0, lost: 0, log: [] }
  window.addEventListener('antun-tunnel-lost', (e) => {
    window.__stub.lost++
    window.__stub.log.push('lost:' + (e.detail || ''))
  })
  window.AnTunDesktop = {
    isDesktop: true, isTauri: true, platform: 'windows',
    loadCredential: async () => ({ privateKey: 'x', publicKey: 'y', endpoint: '' }),
    coreConnect: async () => {
      window.__stub.connects++
      return { ok: true, exitIp: '203.0.113.7', country: 'JP', city: 'Tokyo', colo: 'NRT', latency: 88, error: '' }
    },
    coreStop: async () => { window.__stub.stops++ },
    coreStatus: async () => true,
    coreTraffic: async () => ({ up: 0, down: 0, upTotal: 1000, downTotal: 2000 }),
    probeStatus: async () => {
      probe.calls++
      const next = probe.queue.shift()
      const res = next || { ok: true, exitIp: '', country: '', city: '', colo: '', latency: 55, error: '', fatal: false }
      window.__stub.log.push('probe:' + (res.ok ? 'ok' : (res.fatal ? 'fatal' : 'fail')))
      return res
    },
    notifyStatus: async () => {}, quit: async () => {}, onQuitRequest: () => {},
    saveCredential: async () => {}, setAutoStart: async () => true, getAutoStart: async () => false,
    appInfo: async () => ({}), subscriptionFetch: async () => [], subscriptionParse: async () => [],
    psiphonRegions: async () => [], setPsiphonRegion: async () => {}, netDiagnose: async () => ({}),
    coreUpdateStatus: async () => ({}), coreUpdate: async () => ({}),
  }
})()`

function pageTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => {
        const p = JSON.parse(d).find((t) => t.type === 'page')
        p ? resolve(p) : reject(new Error('no page target'))
      })
    }).on('error', reject)
  })
}

;(async () => {
  const target = await pageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise((r) => { ws.onopen = r })
  const send = (method, params = {}) => {
    const i = ++id
    return new Promise((resolve) => {
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  }
  const ev = async (expression, timeout = 20000) => {
    const i = ++id
    const done = new Promise((resolve) => {
      pending.set(i, resolve)
      setTimeout(() => resolve({ timeout: true }), timeout)
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const m = await done
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text)
    return m.result?.result?.value
  }

  const ring = () => ev(`(()=>document.querySelector('.connect-ring .inner')?.innerText.split('\\n')[0]||null)()`)
  const stub = () => ev(`(()=>({ connects: window.__stub.connects, stops: window.__stub.stops, calls: window.__stub.probe.calls }))()`)
  const pushProbe = (arr) => ev(`(()=>{const q=window.__stub.probe.queue;${arr.map((o) => `q.push(${JSON.stringify(o)});`).join('')}return q.length})()`)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
  await send('Page.navigate', { url: WEB })
  await sleep(2500)
  await ev(`localStorage.setItem('antun-notice-seen','1'); (()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
  await sleep(600)

  const results = []
  const mark = (name, pass, extra = '') => { results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`); console.log(results[results.length - 1]) }

  // 连接（桩直接成功）
  await ev(`(()=>{document.querySelector('.connect-ring')?.click();return 1})()`)
  let connected = false
  for (let i = 0; i < 20; i++) {
    await sleep(700)
    if ((await ring()) === '已连接') { connected = true; break }
  }
  mark('connect', connected)
  if (!connected) { console.log(results.join('\n')); process.exit(1) }

  /** 等待探针被消费若干次（浏览器后台可能把定时器节流到 10s+，按调用次数而非固定时长等待） */
  const waitCalls = async (n, timeout = 90000) => {
    const base = (await stub()).calls
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if ((await stub()).calls >= base + n) return true
      await sleep(1000)
    }
    return false
  }
  const waitConnects = async (target, timeout = 90000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if ((await stub()).connects >= target) return true
      await sleep(1000)
    }
    return false
  }
  const waitLost = async (target, timeout = 90000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const n = await ev(`window.__stub.lost`)
      if (n >= target) return true
      await sleep(1000)
    }
    return false
  }

  // 场景 1：单次探测失败 → 不应断开（旧版本一次失败就清空连接）
  await pushProbe([{ ok: false, error: 'simulated transient', fatal: false }])
  await waitCalls(1)
  await waitCalls(1) // 下一次探测成功，计数归零
  const r1 = await ring()
  mark('single failure keeps connection', r1 === '已连接', `ring=${r1}`)

  // 场景 2：连续 3 次失败 → 断开并自动重连
  const before = await stub()
  await pushProbe([
    { ok: false, error: 'simulated drop 1', fatal: false },
    { ok: false, error: 'simulated drop 2', fatal: false },
    { ok: false, error: 'simulated drop 3', fatal: false },
  ])
  const sawLost = await waitLost(1)
  const reconnected = await waitConnects(before.connects + 1)
  const s2 = await stub()
  const dbg = await ev(`JSON.stringify({lost: window.__stub.lost, log: window.__stub.log.slice(-14)})`)
  mark('3 failures trigger reconnect', sawLost && reconnected, `lost=${sawLost} connects=${before.connects}->${s2.connects} ${dbg}`)
  let recovered = false
  for (let i = 0; i < 25; i++) {
    await sleep(700)
    if ((await ring()) === '已连接') { recovered = true; break }
  }
  mark('auto repair recovers', recovered)

  // 场景 3：核心进程退出（fatal）→ 立即断开 + 自动重连
  const before3 = await stub()
  const lost3 = await ev(`window.__stub.lost`)
  await pushProbe([{ ok: false, error: '核心进程已退出', fatal: true }])
  const sawFatalLost = await waitLost(lost3 + 1)
  const reconnected3 = await waitConnects(before3.connects + 1)
  const s3 = await stub()
  mark('fatal triggers reconnect', sawFatalLost && reconnected3, `connects=${before3.connects}->${s3.connects}`)

  const fails = results.filter((r) => r.startsWith('FAIL')).length
  console.log('\n' + results.join('\n'))
  console.log(fails ? 'FAIL' : 'PASS')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

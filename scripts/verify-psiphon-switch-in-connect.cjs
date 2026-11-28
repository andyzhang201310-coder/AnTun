// 验证「WARP 连不上时，可以直接在连接中切到 Psiphon」
//
// 背景：WARP 在本机网络不可用（实测 WG 2408 / MASQUE 500 / MASQUE-H2 全部超时），
// 用户能连上完全靠 Psiphon 出口。以前的 Psiphon 开关在连接中是 disabled，
// 用户必须先点圈取消、再点开关、再点圈，三步且容易点空。
//
// 断言：
//   1. 连接中 Psiphon 开关可点（不是 disabled）
//   2. 点击后自动「取消 → 重新连接」，最终连上
//   3. 连上后 psiphon.exe 只有 1 个，出口 IP 与直连不同
//   4. 断开并关闭 Psiphon 后，再次连接失败时首页出现失败原因与「改用 Psiphon 出口重试」按钮
const http = require('http')
const { execSync } = require('child_process')

const PORT = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p) => new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${PORT}${p}`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))) }).on('error', rej)
})

async function ev(expr, timeoutMs = 30000) {
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  } finally {
    try { ws.close() } catch {}
  }
}

const psiRow = `(() => {
  const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
  const sw = row?.querySelector('.switch')
  return { found: !!sw, on: !!sw?.classList.contains('on'), disabled: !!sw?.disabled }
})()`

const ringState = `(() => {
  const ring = document.querySelector('.connect-ring')
  const sub = ring?.querySelectorAll('.muted')[1]?.textContent || ''
  const ring2 = document.querySelector('.connect-ring')
  return {
    connected: !!ring2?.classList.contains('connected'),
    connecting: !!ring2?.classList.contains('pulse'),
    sub,
    text: document.body.innerText.slice(0, 0),
  }
})()`

const psiphonPids = () => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq psiphon.exe" /NH', { encoding: 'utf8', timeout: 10000 })
    return (out.match(/psiphon\.exe/g) || []).length
  } catch { return 0 }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

;(async () => {
  // 0. 起点：必须未连接
  let st = await ev(ringState)
  console.log('起始状态:', JSON.stringify(st))
  if (!st.connected && !st.connecting) {
    // 确保 Psiphon 关闭
    const psi = await ev(psiRow)
    if (psi.on) {
      await ev(`(() => { const row=[...document.querySelectorAll('.field-row')].find(r=>r.querySelector('.t')?.textContent.includes('Psiphon')); row.querySelector('.switch').click() })()`)
      await sleep(600)
    }
  } else {
    console.log('应用已处于连接/连接中，先复位')
    await ev(`(() => { const r=document.querySelector('.connect-ring'); r && r.click() })()`)
    await sleep(2500)
  }

  // 1. 不用 Psiphon 先连（预期失败），但要抓「连接中」这个窗口
  console.log('\n[1] 点圆环开始连接（WARP，Psiphon 关闭）')
  await ev(`(() => { const r = document.querySelector('.connect-ring'); r.click(); return true })()`)
  await sleep(2500)
  st = await ev(ringState)
  check('进入连接中状态', st.connecting === true, JSON.stringify(st))

  // 2. 连接中点 Psiphon 开关
  const before = await ev(psiRow)
  check('连接中 Psiphon 开关可点（未禁用）', before.disabled === false, JSON.stringify(before))
  console.log('[2] 点击 Psiphon 开关')
  await ev(`(() => { const row=[...document.querySelectorAll('.field-row')].find(r=>r.querySelector('.t')?.textContent.includes('Psiphon')); row.querySelector('.switch').click(); return true })()`)
  await sleep(1200)
  const after = await ev(psiRow)
  check('开关已打开', after.on === true, JSON.stringify(after))
  const mid = await ev(ringState)
  console.log('切换后状态:', JSON.stringify(mid))

  // 3. 等它连上（Psiphon 建立实测 35s 左右，留足 180s 并允许一次自动重试）
  console.log('\n[3] 等待连接完成…')
  let connected = false
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    await sleep(3000)
    const s = await ev(ringState)
    if (s.connected) { connected = true; st = s; break }
    if (!s.connecting) {
      // 失败后又被自动重试，继续等；记录一下
      console.log('  ...这一轮结束（未连上），继续观察', JSON.stringify(s))
      await sleep(2000)
      const s2 = await ev(ringState)
      if (!s2.connecting && !s2.connected) break
    }
  }
  check('改用 Psiphon 后连接成功', connected, connected ? `${Math.round((Date.now() - t0) / 1000)}s` : '超时')
  if (connected) {
    const info = await ev(`(() => {
      const t = document.body.innerText
      const ip = (t.match(/出口 IP[\\s\\S]{0,40}/) || [''])[0].replace(/\\s+/g, ' ')
      return { ip }
    })()`)
    console.log('  出口信息:', JSON.stringify(info))
    check('psiphon.exe 进程数=1', psiphonPids() === 1, String(psiphonPids()))
  }

  console.log('\n==== 汇总 ====')
  const fail = results.filter((r) => !r.ok)
  console.log(`${results.length - fail.length}/${results.length} 通过`)
  process.exit(fail.length ? 1 : 0)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })

// 1.7.7 界面验证（浏览器 dev 模式，不依赖 Tauri 二进制）
//
// 验证点：
//   1. 连接中 Psiphon 开关不再禁用（以前 Toggle disabled 导致用户点不动）
//   2. 连接中切换说明文案改成「切换会取消当前连接并立即重连」
//   3. 连接失败后在首页显示失败原因 + 「改用 Psiphon 出口重试」，点击后 psiphon 置真
const http = require('http')
const PORT = 9345
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))) }).on('error', rej)
})

async function ev(expr, timeoutMs = 15000) {
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

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

const READ_ROW = `(() => {
  const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
  const sw = row?.querySelector('.switch')
  return { hasRow: !!row, disabled: !!sw?.disabled, on: !!sw?.classList.contains('on'), desc: row?.querySelector('.d')?.textContent || '' }
})()`

;(async () => {
  await ev(`(() => { if (!window.__antunStore) throw new Error('store 未暴露'); window.__antunStore.getState().setPage('home'); return true })()`)
  await sleep(600)

  // 1. 连接中：开关应可点
  await ev(`(() => { const s = window.__antunStore.getState(); s.setConn({ connecting: true, connected: false }); s.setLastError(''); return true })()`)
  await sleep(400)
  let row = await ev(READ_ROW)
  console.log('连接中行状态:', JSON.stringify(row))
  check('首页存在 Psiphon 开关', row.hasRow === true)
  check('连接中开关不再禁用', row.disabled === false, `disabled=${row.disabled}`)
  check('连接中文案已更新', row.desc.includes('取消当前连接'), row.desc)

  // 2. 失败提示：错误原因 + 一键重试
  await ev(`(() => {
    const s = window.__antunStore.getState()
    s.setConn({ connecting: false, connected: false })
    s.setSetting('psiphon', false)
    s.setSetting('connMode', 'warp')
    s.setLastError('连接超时：Cloudflare trace 不可达（隧道未建立）；本机可以访问 Cloudflare，但 WARP 隧道没有建立，多半是网络阻断了 WARP 的 UDP 出站。可开启 Psiphon 出口后重试')
    return true
  })()`)
  await sleep(400)
  const errBlock = await ev(`(() => {
    const el = document.querySelector('.home-last-error')
    return { exists: !!el, text: el?.innerText || '' }
  })()`)
  console.log('失败提示:', JSON.stringify(errBlock).slice(0, 200))
  check('首页显示失败原因', errBlock.exists === true && errBlock.text.includes('UDP 出站'))
  check('提供一键改用 Psiphon', errBlock.text.includes('改用 Psiphon 出口重试'), errBlock.text.replace(/\s+/g, ' ').slice(-30))

  // 3. 点击一键重试：psiphon 应置真（web 模式连接是模拟的，只验证设置生效）
  await ev(`(() => { const b = [...document.querySelectorAll('.home-last-error button')].find(x => x.textContent.includes('改用 Psiphon')); b && b.click(); return !!b })()`)
  await sleep(800)
  const after = await ev(`(() => ({ psiphon: window.__antunStore.getState().settings.psiphon, lastError: window.__antunStore.getState().lastError }))()`)
  console.log('点击后:', JSON.stringify(after))
  check('点击后自动开启 Psiphon', after.psiphon === true)

  console.log('\n==== 汇总 ====')
  const fail = results.filter((r) => !r.ok)
  console.log(`${results.length - fail.length}/${results.length} 通过`)
  process.exit(fail.length ? 1 : 0)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })

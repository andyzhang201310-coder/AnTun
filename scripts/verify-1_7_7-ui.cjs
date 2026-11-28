// 1.7.7 逐项验证（浏览器 dev 模式，不依赖 Tauri 二进制）
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
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      throw new Error('JS: ' + String(d).split('\n')[0])
    }
    return r.result?.value
  } finally { try { ws.close() } catch {} }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 读取某个 title 含关键字的 field-row（优先返回带 switch 的那一行）
const rowOf = (kw) => `(() => {
  const rows = [...document.querySelectorAll('.field-row')]
  const hits = rows.filter(r => (r.querySelector('.t')?.textContent || '').includes('${kw}'))
  const row = hits.find(r => r.querySelector('.switch')) || hits[0]
  if (!row) return { found: false, titles: rows.map(r => r.querySelector('.t')?.textContent).filter(Boolean) }
  const sw = row.querySelector('.switch')
  return {
    found: true,
    hasSwitch: !!sw,
    disabled: sw ? !!sw.disabled : null,
    on: sw ? sw.classList.contains('on') : null,
    desc: row.querySelector('.d')?.textContent || '',
    title: row.querySelector('.t')?.textContent || '',
    hits: hits.length
  }
})()`

;(async () => {
  const base = await ev(`({ v: document.title, hasStore: typeof window.__antunStore === 'object' })`)
  check('页面为 1.7.7 且 store 已暴露', base.hasStore === true, `title=${base.v}`)

  // ---------- 1. 首页：连接中 Psiphon 开关可点 ----------
  await ev(`(() => { const s = window.__antunStore.getState(); s.setPage('home'); s.setConn({ connecting: false, connected: false }); s.setLastError(''); return 1 })()`)
  await sleep(500)
  await ev(`(() => { const s = window.__antunStore.getState(); s.setSetting('connMode', 'warp'); s.setSetting('psiphon', false); s.setConn({ connecting: true, connected: false }); return 1 })()`)
  await sleep(500)
  let r = await ev(rowOf('Psiphon'))
  console.log('  行状态:', JSON.stringify(r).slice(0, 240))
  check('首页存在 Psiphon 开关行', r.found === true)
  check('连接中开关可点（未禁用）', r.disabled === false, `disabled=${r.disabled}`)
  check('连接中文案提示会取消并重连', r.desc.includes('取消当前连接'), r.desc)

  // ---------- 2. 首页：连接失败给出原因 + 一键改用 Psiphon ----------
  await ev(`(() => {
    const s = window.__antunStore.getState()
    s.setConn({ connecting: false, connected: false })
    s.setSetting('psiphon', false)
    s.setSetting('connMode', 'warp')
    s.setLastError('连接超时：Cloudflare trace 不可达（隧道未建立）；本机可以访问 Cloudflare，但 WARP 隧道没有建立，多半是网络阻断了 WARP 的 UDP 出站。可开启 Psiphon 出口后重试')
    return 1
  })()`)
  await sleep(600)
  const err = await ev(`(() => {
    const el = document.querySelector('.home-last-error')
    if (!el) return { exists: false }
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent.includes('改用 Psiphon'))
    return { exists: true, text: el.innerText.replace(/\\s+/g, ' '), hasBtn: !!btn }
  })()`)
  console.log('  失败提示:', JSON.stringify(err).slice(0, 300))
  check('首页显示失败原因', err.exists === true)
  check('原因含可操作建议（UDP 出站 / 改用 Psiphon）', err.text.includes('UDP 出站'))
  check('提供「改用 Psiphon 出口重试」按钮', err.hasBtn === true)

  // ---------- 3. 点击后自动开启 Psiphon ----------
  await ev(`(() => { const b = [...document.querySelectorAll('.home-last-error button')].find(x => x.textContent.includes('改用 Psiphon')); if (b) b.click(); return !!b })()`)
  await sleep(900)
  const after = await ev(`(() => { const s = window.__antunStore.getState(); return { psiphon: s.settings.psiphon, lastError: (s.lastError || '').slice(0, 20) } })()`)
  console.log('  点击后:', JSON.stringify(after))
  check('点击后 Psiphon 置为开启', after.psiphon === true)

  // ---------- 4. 设置页：同一个开关在连接中也可点 ----------
  await ev(`(() => { const s = window.__antunStore.getState(); s.setPage('settings'); s.setConn({ connecting: true, connected: false }); return 1 })()`)
  await sleep(700)
  const s2 = await ev(rowOf('Psiphon'))
  console.log('  设置页行:', JSON.stringify(s2).slice(0, 240))
  check('设置页存在 Psiphon 开关行', s2.found === true)
  check('设置页连接中开关可点', s2.disabled === false, `disabled=${s2.disabled}`)

  // ---------- 5. 连接中取消按钮可用 ----------
  await ev(`(() => { const s = window.__antunStore.getState(); s.setPage('home'); s.setConn({ connecting: true, connected: false }); return 1 })()`)
  await sleep(600)
  const ring = await ev(`(() => { const el = document.querySelector('.connect-ring'); return { exists: !!el, cls: el?.className || '' } })()`)
  check('连接中连接圈可点击取消', ring.exists === true && ring.cls.includes('cancellable'), ring.cls)

  // 复位
  await ev(`(() => { const s = window.__antunStore.getState(); s.setConn({ connecting: false, connected: false }); s.setLastError(''); s.setSetting('psiphon', false); return 1 })()`)

  console.log('\n==== 汇总 ====')
  const fail = results.filter((x) => !x.ok)
  console.log(`${results.length - fail.length}/${results.length} 通过`)
  if (fail.length) console.log('失败项: ' + fail.map((f) => f.name).join('; '))
  process.exit(fail.length ? 1 : 0)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })

// 1.7.7 逐项验证 v2（浏览器 dev 模式）
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

const rowOf = (kw) => `(() => {
  const rows = [...document.querySelectorAll('.field-row')]
  const hits = rows.filter(r => (r.querySelector('.t')?.textContent || '').includes('${kw}'))
  const row = hits.find(r => r.querySelector('.switch')) || hits[0]
  if (!row) return { found: false }
  const sw = row.querySelector('.switch')
  return {
    found: true, hasSwitch: !!sw,
    disabled: sw ? !!sw.disabled : null,
    on: sw ? sw.classList.contains('on') : null,
    desc: row.querySelector('.d')?.textContent || '',
    title: row.querySelector('.t')?.textContent || '',
    hits: hits.length
  }
})()`

;(async () => {
  const base = await ev(`({ v: document.title, hasStore: typeof window.__antunStore === 'function' })`)
  check('页面已加载且 store 已暴露', base.hasStore === true, `title=${base.v}`)

  // 1. 首页连接中 Psiphon 开关可点
  await ev(`(() => { const s = window.__antunStore.getState(); s.setPage('home'); s.setConn({ connecting: false, connected: false }); s.setLastError(''); return 1 })()`)
  await sleep(500)
  await ev(`(() => { const s = window.__antunStore.getState(); s.setSetting('connMode', 'warp'); s.setSetting('psiphon', false); s.setConn({ connecting: true, connected: false }); return 1 })()`)
  await sleep(500)
  let r = await ev(rowOf('Psiphon'))
  console.log('  首页行:', JSON.stringify(r).slice(0, 240))
  check('首页存在 Psiphon 开关行', r.found === true && r.hasSwitch === true)
  check('首页连接中开关可点', r.disabled === false, `disabled=${r.disabled}`)
  check('首页连接中文案提示取消并重连', r.desc.includes('取消当前连接'), r.desc)

  // 2. 失败原因 + 一键改用 Psiphon
  await ev(`(() => {
    const s = window.__antunStore.getState()
    s.setConn({ connecting: false, connected: false })
    s.setSetting('psiphon', false); s.setSetting('connMode', 'warp')
    s.setLastError('连接超时：Cloudflare trace 不可达（隧道未建立）；本机可以访问 Cloudflare，但 WARP 隧道没有建立，多半是网络阻断了 WARP 的 UDP 出站。可开启 Psiphon 出口后重试')
    return 1 })()`)
  await sleep(600)
  const err = await ev(`(() => {
    const el = document.querySelector('.home-last-error')
    if (!el) return { exists: false }
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent.includes('改用 Psiphon'))
    return { exists: true, text: el.innerText.replace(/\\s+/g, ' '), hasBtn: !!btn }
  })()`)
  console.log('  失败提示:', JSON.stringify(err).slice(0, 280))
  check('首页显示失败原因', err.exists === true)
  check('原因含可操作建议（UDP 出站）', (err.text || '').includes('UDP 出站'))
  check('提供「改用 Psiphon 出口重试」按钮', err.hasBtn === true)

  // 3. 点击后自动开 Psiphon
  await ev(`(() => { const b = [...document.querySelectorAll('.home-last-error button')].find(x => x.textContent.includes('改用 Psiphon')); if (b) b.click(); return !!b })()`)
  await sleep(900)
  const after = await ev(`(() => ({ psiphon: window.__antunStore.getState().settings.psiphon }))()`)
  check('点击后 Psiphon 置为开启', after.psiphon === true, `psiphon=${after.psiphon}`)

  // 4. 设置页开关
  await ev(`(() => { const s = window.__antunStore.getState(); s.setPage('settings'); s.setConn({ connecting: true, connected: false }); return 1 })()`)
  await sleep(800)
  const s2 = await ev(rowOf('Psiphon'))
  console.log('  设置页行:', JSON.stringify(s2).slice(0, 260))
  check('设置页存在 Psiphon 开关行', s2.found === true && s2.hasSwitch === true, `title=${s2.title} hits=${s2.hits}`)
  check('设置页连接中开关可点', s2.disabled === false, `disabled=${s2.disabled}`)
  check('设置页连接中文案提示可切', s2.desc.includes('直接切换') || s2.desc.includes('取消'), s2.desc)

  // 5. 连接圈取消
  await ev(`(() => { const s = window.__antunStore.getState(); s.setPage('home'); s.setConn({ connecting: true, connected: false }); return 1 })()`)
  await sleep(600)
  const ring = await ev(`(() => { const el = document.querySelector('.connect-ring'); return { exists: !!el, cls: el?.className || '' } })()`)
  check('连接中连接圈可点击取消', ring.exists === true && ring.cls.includes('cancellable'), ring.cls.trim())

  // 6. 订阅模式下禁用
  await ev(`(() => { const s = window.__antunStore.getState(); s.setSetting('connMode', 'subscription'); return 1 })()`)
  await sleep(600)
  const s3 = await ev(rowOf('Psiphon'))
  check('订阅模式下 Psiphon 开关禁用', s3.disabled === true, `disabled=${s3.disabled}`)

  await ev(`(() => { const s = window.__antunStore.getState(); s.setConn({ connecting: false, connected: false }); s.setLastError(''); s.setSetting('psiphon', false); s.setSetting('connMode', 'warp'); return 1 })()`)

  console.log('\n==== 汇总 ====')
  const fail = results.filter((x) => !x.ok)
  console.log(`${results.length - fail.length}/${results.length} 通过`)
  if (fail.length) console.log('失败项: ' + fail.map((f) => f.name).join('; '))
  process.exit(fail.length ? 1 : 0)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })

/**
 * 页面视图状态跨页保留验收（同类隐患一并修复）
 * 页面在 App.tsx 里是条件渲染的，切页即卸载，组件内 state 必丢。这里逐项验证：
 * 1) 节点页：搜索词 + 协议过滤切页后保留；搜索词只在本进程内，reload 后清空（有意为之）
 * 2) 节点页：协议过滤是设置项，reload 后仍保留
 * 3) 日志页：分栏切页后保留，reload 后仍保留
 * 4) 模式页：排序（1.7.1 已修）复测一次，防止回归
 * 用法：vite preview 起 4173，无头 Chrome 带 --remote-debugging-port=9342
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const out = []
const log = (s) => { out.push(s); console.log(s) }
const fail = (s) => { out.push('FAIL: ' + s); console.log('FAIL: ' + s); process.exitCode = 1 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})

const PREFS = {
  settings: { connMode: 'warp', frontNodeId: '', proto: 'awg', lang: 'zh', theme: 'light', nodeProtoFilter: 'all', logsTab: 'runtime', subSort: 'default' },
  endpointsPreview: 1,
}

;(async () => {
  const list = await getJson('http://127.0.0.1:9342/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到页面目标')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq
    pend.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result?.value
  }
  await send('Runtime.enable', {})
  await send('Page.enable', {})
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

  const goto = async (label) => {
    const ok = await ev(`(()=>{
      const els=[...document.querySelectorAll('button,a,li,div[role="button"]')];
      const el=els.find(e=>e.innerText&&e.innerText.trim()===${JSON.stringify(label)}&&e.offsetParent);
      if(!el) return false; el.click(); return true
    })()`)
    if (!ok) throw new Error(`导航失败：${label}`)
    await sleep(700)
  }
  const setInput = async (selector, value) => {
    await ev(`(()=>{
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      return true
    })()`)
    await sleep(400)
  }
  const clickText = async (sel, text) => {
    const ok = await ev(`(()=>{
      const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.innerText.trim()===${JSON.stringify(text)});
      if(!el) return false; el.click(); return true
    })()`)
    if (!ok) throw new Error(`点不到「${text}」(${sel})`)
    await sleep(400)
  }

  await send('Page.navigate', { url: 'http://localhost:4173/' })
  await sleep(900)
  await ev(`localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify({ state: PREFS, version: 0 }))});localStorage.setItem('antun-notice-seen','1');1`)
  await send('Page.reload')
  await sleep(2200)

  // ===== [1] 节点页：搜索词 + 协议过滤 =====
  await goto('节点')
  await setInput('input[placeholder]', '162.159')
  await clickText('.segment button', 'AWG')
  const before = JSON.parse(await ev(`JSON.stringify({
    q: document.querySelector('input[placeholder]').value,
    active: [...document.querySelectorAll('.segment button')].filter(b=>b.classList.contains('active')).map(b=>b.innerText),
    rows: document.querySelectorAll('.node-row').length,
  })`))
  log(`[1] 节点页设置后：搜索="${before.q}" 过滤=${JSON.stringify(before.active)} 行数=${before.rows}`)

  await goto('首页')
  const offPage = await ev(`!document.querySelector('input[placeholder]')`)
  await goto('节点')
  const after = JSON.parse(await ev(`JSON.stringify({
    q: document.querySelector('input[placeholder]').value,
    active: [...document.querySelectorAll('.segment button')].filter(b=>b.classList.contains('active')).map(b=>b.innerText),
    rows: document.querySelectorAll('.node-row').length,
  })`))
  log(`[1] 切页前已卸载=${offPage} → 回来：搜索="${after.q}" 过滤=${JSON.stringify(after.active)} 行数=${after.rows}`)
  if (!offPage) fail('节点页切走后没有卸载，测试前提不成立')
  if (after.q !== '162.159') fail('搜索词切页后被清空')
  if (!after.active.includes('AWG')) fail('协议过滤切页后被重置')

  // ===== [2] 协议过滤 reload 后仍在，搜索词按设计清空 =====
  await sleep(700)
  await send('Page.reload')
  await sleep(2200)
  await goto('节点')
  const afterReload = JSON.parse(await ev(`JSON.stringify({
    q: document.querySelector('input[placeholder]').value,
    active: [...document.querySelectorAll('.segment button')].filter(b=>b.classList.contains('active')).map(b=>b.innerText),
  })`))
  log(`[2] reload 后：搜索="${afterReload.q}"（应为空） 过滤=${JSON.stringify(afterReload.active)}（应仍是 AWG）`)
  if (afterReload.q !== '') fail('搜索词不该持久化到磁盘（重启后开屏即被过滤）')
  if (!afterReload.active.includes('AWG')) fail('协议过滤没有持久化')

  // ===== [3] 日志页分栏 =====
  await goto('日志')
  await clickText('.segment button', '诊断')
  await goto('首页')
  await goto('日志')
  const tabAfter = await ev(`(()=>{const b=[...document.querySelectorAll('.segment button')].find(x=>x.classList.contains('active'));return b?b.innerText:'<无>'})()`)
  log(`[3] 日志页切页回来当前分栏="${tabAfter}"（应为 诊断）`)
  if (tabAfter !== '诊断') fail('日志分栏切页后被重置')
  await send('Page.reload')
  await sleep(2200)
  await goto('日志')
  const tabReload = await ev(`(()=>{const b=[...document.querySelectorAll('.segment button')].find(x=>x.classList.contains('active'));return b?b.innerText:'<无>'})()`)
  log(`[3] reload 后分栏="${tabReload}"（应为 诊断）`)
  if (tabReload !== '诊断') fail('日志分栏没有持久化')

  // ===== [4] 模式页排序回归 =====
  await goto('模式')
  const sortBefore = await ev(`(()=>{const s=document.querySelector('.node-toolbar select');return s?s.value:'<无下拉框：当前没有订阅节点>'})()`)
  log(`[4] 模式页排序=${sortBefore}（排序持久化由 verify-modes-sort.cjs 覆盖，这里只做回归探针）`)

  fs.writeFileSync(path.join(__dirname, '..', 'verify-view-state.log'), out.join('\n') + '\n')
  ws.close()
  log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
})().catch((e) => {
  fail(e.message)
  console.log('RESULT: FAIL')
})

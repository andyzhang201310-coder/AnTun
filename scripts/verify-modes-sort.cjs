/**
 * 模式页排序持久化验收（纯前端，不建隧道）：
 * 1) 预置 subSort='speed' 打开 → 模式页下拉框就是「速度优先」
 * 2) 在页面上改成「延迟优先」→ 切到首页再切回来，仍是「延迟优先」
 * 3) 落盘到 antun-prefs.settings.subSort，整页 reload 后依然是「延迟优先」
 * 4) 改回「默认顺序」也要落盘（不能只在 state 里改）
 * 用法：vite preview 起 4173，无头 Chrome 带 --remote-debugging-port=9337
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

const mkNode = (i) => ({
  id: `n${i}`, subId: 's1', name: `节点 ${i}`, nodeType: 'vless',
  server: `104.17.128.${i}`, port: 443,
  config: `  - name: "SUB-NODE-${i}"\n    type: vless\n    server: 104.17.128.${i}\n    port: 443\n`,
})

const PREFS = {
  settings: { connMode: 'subscription', subExit: 'node', subViaWarp: true, frontNodeId: 'n1', proto: 'gool', lang: 'zh', theme: 'light', subSort: 'speed' },
  subNodes: [1, 2, 3, 4, 5].map(mkNode),
}

;(async () => {
  const list = await getJson('http://127.0.0.1:9337/json')
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

  // 侧栏导航：按文案点，避免依赖 DOM 结构
  const goto = async (label) => {
    const ok = await ev(`(()=>{
      const els=[...document.querySelectorAll('button,a,li,div[role="button"]')];
      const el=els.find(e=>e.innerText&&e.innerText.trim()===${JSON.stringify(label)}&&e.offsetParent);
      if(!el) return false; el.click(); return true
    })()`)
    if (!ok) throw new Error(`导航失败：找不到「${label}」`)
    await sleep(700)
  }
  const sortValue = () => ev(`(()=>{const s=document.querySelector('.node-toolbar select');return s?s.value:'<无下拉框>'})()`)
  const sortText = () => ev(`(()=>{const s=document.querySelector('.node-toolbar select');return s?s.options[s.selectedIndex].textContent:'<无下拉框>'})()`)
  const setSort = async (v) => {
    await ev(`(()=>{
      const s=document.querySelector('.node-toolbar select');
      if(!s) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(v)});
      s.dispatchEvent(new Event('change',{bubbles:true}));
      return true
    })()`)
    await sleep(400)
  }
  const savedSort = () => ev(`(()=>{try{const p=JSON.parse(localStorage.getItem('antun-prefs'));return (p.state&&p.state.settings&&p.state.settings.subSort)||'<无>' }catch(e){return '<解析失败>'}})()`)

  const load = async (prefs) => {
    await send('Page.navigate', { url: 'http://localhost:4173/' })
    await sleep(900)
    await ev(`localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify({ state: prefs, version: 0 }))});localStorage.setItem('antun-notice-seen','1');1`)
    await send('Page.reload')
    await sleep(2000)
  }

  await load(PREFS)

  // [1] 预置值生效
  await goto('模式')
  const v1 = await sortValue()
  const t1 = await sortText()
  log(`[1] 预置 subSort=speed → 下拉框 value=${v1} 文案="${t1}"`)
  if (v1 !== 'speed') fail('预置的速度优先没有初始化到下拉框')

  // [2] 改成延迟优先 → 切页往返
  await setSort('delay')
  const afterChange = await sortValue()
  log(`[2] 改成延迟优先后 value=${afterChange}`)
  if (afterChange !== 'delay') fail('下拉框没有切换到延迟优先')

  await goto('首页')
  // 模式页是条件渲染，切走就该整体卸载（组件内 state 也随之销毁——这正是原 bug 的成因）
  const onHome = await ev(`!document.querySelector('.node-toolbar')`)
  await goto('模式')
  const backValue = await sortValue()
  const backText = await sortText()
  log(`[2] 切到首页（模式页已卸载=${onHome}）→ 切回模式页 value=${backValue} 文案="${backText}"`)
  if (!onHome) fail('模式页切走后没有卸载，测试前提不成立')
  if (backValue !== 'delay') fail('切页回来后排序被重置')

  // [3] 落盘 + 整页 reload
  await sleep(700) // persist 是 500ms 合并写
  const disk = await savedSort()
  log(`[3] localStorage 里 settings.subSort=${disk}`)
  if (disk !== 'delay') fail('排序没有写进 localStorage')

  await send('Page.reload')
  await sleep(2000)
  await goto('模式')
  const afterReload = await sortValue()
  log(`[3] 整页 reload 后 value=${afterReload}`)
  if (afterReload !== 'delay') fail('重新加载后排序没有保留')

  // [4] 改回默认顺序也要落盘
  await setSort('default')
  await sleep(700)
  const disk2 = await savedSort()
  const v4 = await sortValue()
  log(`[4] 改回默认顺序 value=${v4} 落盘=${disk2}`)
  if (v4 !== 'default' || disk2 !== 'default') fail('改回默认顺序没有正确落盘')

  // [5] 老存档（没有 subSort 字段）不应崩，回落到默认顺序
  const oldPrefs = JSON.parse(JSON.stringify(PREFS))
  delete oldPrefs.settings.subSort
  await load(oldPrefs)
  await goto('模式')
  const legacy = await sortValue()
  const rows = await ev(`document.querySelectorAll('.node-row').length`)
  log(`[5] 旧存档无 subSort → value=${legacy} 节点行数=${rows}（应 default / 5）`)
  if (legacy !== 'default') fail('旧存档没有回落到默认顺序')
  if (rows !== 5) fail('旧存档下节点列表没有正常渲染')

  fs.writeFileSync(path.join(__dirname, '..', 'verify-modes-sort.log'), out.join('\n') + '\n')
  ws.close()
  log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
})().catch((e) => {
  fail(e.message)
  console.log('RESULT: FAIL')
})

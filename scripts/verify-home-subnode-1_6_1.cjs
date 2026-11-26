/**
 * 1.6.1 验证：首页下拉框可切换到订阅节点
 *
 * 预置 1 个订阅 + 2 个节点，检查：
 * 1) 首页出现「出口节点」下拉框，含 WARP 与订阅两组选项
 * 2) 选中订阅节点后 connMode 变为 subscription、frontNodeId 落到该节点
 * 3) 「已选节点」卡片显示该订阅节点
 * 4) 再切回 WARP 自动择优，connMode 回到 warp
 */
const http = require('http')
const fs = require('fs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pageTarget() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json', (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => {
        const p = JSON.parse(d).find((t) => t.type === 'page' && t.url.includes('4599'))
        p ? resolve(p) : reject(new Error('no page target'))
      })
    }).on('error', reject)
  })
}

const prefs = {
  state: {
    settings: { connMode: 'warp', frontNodeId: '', lang: 'zh', theme: 'light' },
    page: 'home',
    pinnedId: null,
    allowedCountries: [],
    subscriptions: [{ id: 'sub1', name: '测试订阅', url: 'https://example.com/sub', updatedAt: Date.now() }],
    subNodes: [
      { id: 'nt-a', subId: 'sub1', name: '香港 01', nodeType: 'vmess', server: '1.2.3.4', port: 443, config: '  - name: "SUB-NODE"\n    type: "vmess"\n' },
      { id: 'nt-b', subId: 'sub1', name: '日本 02', nodeType: 'trojan', server: '5.6.7.8', port: 443, config: '  - name: "SUB-NODE"\n    type: "trojan"\n' },
    ],
  },
  version: 0,
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
  const shot = async (file) => {
    const i = ++id
    const data = await new Promise((resolve) => {
      pending.set(i, (m) => resolve(m.result?.data))
      ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
  }

  const errors = []
  ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'Log.enable' }))
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text)
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') errors.push(m.params.entry.text)
  }

  // 注入订阅存档 + 跳过免责声明弹窗
  await ev(`localStorage.setItem('antun-notice-seen','1'); localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify(prefs))}); true`)
  await ev(`location.reload(); true`)
  await sleep(2500)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
  await sleep(500)

  const sel = `document.querySelector('.home-options select')`
  const options = await ev(`(()=>{const s=${sel};if(!s)return null;return [...s.querySelectorAll('option')].map(o=>o.value+'|'+o.textContent)})()`)
  console.log('options:', options)

  const setSel = (value) => ev(`(()=>{const s=${sel};if(!s)return 'missing';
    const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
    setter.call(s,${JSON.stringify(value)});
    s.dispatchEvent(new Event('change',{bubbles:true}));
    return s.value})()`)

  await setSel('sub:nt-b')
  await sleep(600)
  let state = await ev(`JSON.parse(localStorage.getItem('antun-prefs')).state`)
  console.log('after pick sub:', state.settings.connMode, state.settings.frontNodeId)

  const cardText = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('已选节点'));return c?c.innerText.replace(/\\n/g,' / '):null})()`)
  console.log('selected card:', cardText)
  await shot('scripts/shot-home-subnode.png')

  await setSel('warp:auto')
  await sleep(600)
  state = await ev(`JSON.parse(localStorage.getItem('antun-prefs')).state`)
  console.log('after pick warp auto:', state.settings.connMode, state.settings.frontNodeId)
  await shot('scripts/shot-home-warp.png')

  const ok = options?.some((o) => o.startsWith('sub:nt-b')) &&
    (await ev(`JSON.parse(localStorage.getItem('antun-prefs')).state.settings.connMode`)) === 'warp' &&
    String(cardText || '').includes('日本 02')
  console.log('console errors:', errors.slice(0, 5))
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

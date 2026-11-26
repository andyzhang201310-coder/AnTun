/**
 * 1.6.0 验证：订阅节点一键测速（延迟 + 速度，多线程）
 *
 * 注入 3 个可用的 WARP 出站块 + 1 个核心无法加载的坏节点，
 * 检查：坏节点被跳过、延迟与速度并发测出、排序与进度 UI 正常。
 */
const http = require('http')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pageTarget() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => {
        const p = JSON.parse(d).find((t) => t.type === 'page')
        p ? resolve(p) : reject(new Error('no page target'))
      })
    }).on('error', reject)
  })
}

const WG = (name) => `  - name: "SUB-NODE"
    type: "wireguard"
    private-key: "AO9FFXpvI2abd29iiuIskLoRg3nkT3j1VGs1M/1cj3s="
    ip: 172.16.0.2
    peers:
      - server: 8.35.211.178
        port: 2408
        public-key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo="
        allowed-ips: ['0.0.0.0/0']
        persistent-keepalive: 25
    mtu: 1280
    udp: true
`

const nodes = [
  { id: 'nt-a', subId: 'sub1', name: 'WARP 测试 A', nodeType: 'wireguard', server: '8.35.211.178', port: 2408, config: WG() },
  { id: 'nt-b', subId: 'sub1', name: 'WARP 测试 B', nodeType: 'wireguard', server: '8.35.211.178', port: 2408, config: WG() },
  { id: 'nt-c', subId: 'sub1', name: 'WARP 测试 C', nodeType: 'wireguard', server: '8.35.211.178', port: 2408, config: WG() },
  {
    id: 'nt-bad', subId: 'sub1', name: '坏节点', nodeType: 'bogus', server: '1.2.3.4', port: 1,
    config: '  - name: "SUB-NODE"\n    type: "not-a-real-proxy"\n    server: "1.2.3.4"\n    port: 1\n',
  },
]

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
  const ev = async (expression, timeout = 180000) => {
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
  const click = (text) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return 'missing';if(b.disabled)return 'disabled';b.click();return 'clicked'})()`)
  const shot = async (file) => {
    const i = ++id
    const data = await new Promise((resolve) => {
      pending.set(i, (m) => resolve(m.result?.data))
      ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    })
    require('fs').writeFileSync(file, Buffer.from(data, 'base64'))
  }

  await ev(`localStorage.setItem('antun-notice-seen','1'); true`)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();document.querySelector('.btn-block')?.click();return 1})()`)
  await sleep(400)

  // 注入订阅节点后重载，让 store 从 localStorage 重新水合
  await ev(`(()=>{
    const raw = JSON.parse(localStorage.getItem('antun-prefs') || '{}')
    const st = raw.state || {}
    st.subscriptions = [{ id: 'sub1', name: '测试订阅', url: 'https://example.com/sub.txt', updatedAt: Date.now() }]
    st.subNodes = ${JSON.stringify(nodes)}
    st.settings = Object.assign({}, st.settings, { connMode: 'subscription', frontNodeId: 'nt-a' })
    raw.state = st
    raw.version = raw.version || 0
    localStorage.setItem('antun-prefs', JSON.stringify(raw))
    return st.subNodes.length
  })()`)
  await ev(`location.reload(); true`)
  await sleep(2500)

  await ev(`localStorage.setItem('antun-notice-seen','1'); true`)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();document.querySelector('.btn-block')?.click();return 1})()`)
  await sleep(400)

  console.log('nav', await click('模式'))
  await sleep(700)
  const rowsBefore = await ev(`document.querySelectorAll('.node-row.t').length`)
  const toolbar = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.querySelector('.node-toolbar'));return c?[...c.querySelectorAll('.node-toolbar button')].map(b=>b.innerText.trim()):[]})()`)

  const t0 = Date.now()
  console.log('test', await click('一键测速'))
  let card = ''
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    card = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.querySelector('.node-toolbar'));return c?c.innerText.replace(/\\n/g,' | '):''})()`)
    if (/测速完成|测速失败|停止测速/.test(card) && !/测速中/.test(card)) break
  }
  const elapsed = Date.now() - t0

  const parsed = await ev(`(()=>{
    const rows=[...document.querySelectorAll('.node-row.t')]
    return rows.map(r=>{
      const cells=[...r.querySelectorAll('.cell')]
      return { name: cells[0]?.innerText, type: cells[1]?.innerText, addr: cells[2]?.innerText, delay: cells[3]?.innerText, speed: cells[4]?.innerText }
    })
  })()`)

  await shot('D:/VSCode/AnTun/.workbuddy/tmp/node-test-1_6.png')

  console.log(JSON.stringify({ rowsBefore, toolbar, elapsedMs: elapsed, parsed, card: card.slice(0, 400) }, null, 2))
  ws.close()
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

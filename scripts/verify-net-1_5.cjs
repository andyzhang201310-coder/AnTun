/** 1.5.0 验证：DNS 防泄漏落盘配置、DNS 泄漏检测、AI 站点连通性 */
const http = require('http')
const net = require('net')
const fs = require('fs')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.setTimeout(800)
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
    s.on('timeout', () => { s.destroy(); resolve(false) })
  })
}

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
  const click = (text) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`)

  await ev(`localStorage.setItem('antun-notice-seen','1'); true`)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return true})()`)
  await ev(`document.querySelector('.btn-block')?.click(); true`)
  await sleep(300)

  // 先确保处于断开状态
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r&&r.className.includes('connected'))r.click();return true})()`)
  await sleep(1500)

  await click('首页')
  await sleep(300)
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r&&!r.className.includes('connected'))r.click();return true})()`)
  let connected = false
  for (let i = 0; i < 70; i++) {
    connected = await ev(`!!document.querySelector('.connect-ring.connected')`)
    if (connected && await portOpen(7890)) break
    await sleep(1000)
  }

  const cfgPath = path.join(process.env.APPDATA || '', 'com.antun.client', 'config.yaml')
  const cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : ''
  const cfgChecks = {
    exists: !!cfg,
    fakeIp: cfg.includes('enhanced-mode: fake-ip'),
    doh: cfg.includes('https://1.1.1.1/dns-query'),
    respectRules: cfg.includes('respect-rules: true'),
    ipv6Off: cfg.includes('ipv6: false'),
    dnsPinned: cfg.includes('IP-CIDR,1.1.1.1/32,PROXY'),
  }

  const dns = await ev(`(async()=>{try{const t0=Date.now();const v=await window.AnTunDesktop.netDiagnose(7890,'dns');return {ms:Date.now()-t0,v}}catch(e){return {err:String(e)}}})()`)
  const ai = await ev(`(async()=>{try{const t0=Date.now();const v=await window.AnTunDesktop.netDiagnose(7890,'ai');return {ms:Date.now()-t0,v}}catch(e){return {err:String(e)}}})()`)

  // UI：设置页按钮与结论展示
  await click('设置')
  await sleep(600)
  await click('DNS 泄漏检测')
  let card = ''
  for (let i = 0; i < 30; i++) {
    card = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('网络诊断'));return c?c.innerText.replace(/\\n/g,' | '):''})()`)
    if (/解析器|未取到|无泄漏|泄漏/.test(card) && !/检测中…$/.test(card)) break
    await sleep(1000)
  }

  await ev(`window.AnTunDesktop?.coreStop?.(); true`)
  await sleep(500)

  console.log(JSON.stringify({ connected, portOpen: await portOpen(7890), cfgChecks, dns, ai, diagCard: card }, null, 2))
  ws.close()
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

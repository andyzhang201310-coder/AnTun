/**
 * 测量 Tauri 主线程是否被流量命令堵住：
 * 连接后，反复调用一个极轻量的命令 core_status，
 * 如果它的往返时延周期性飙升到 ~2s，说明同步 core_traffic 阻塞了命令处理线程，
 * 真实鼠标点击也会被一起延迟（CDP 的 JS click 测不出来）。
 */
const http = require('http')

const CDP = process.env.CDP_PORT || '9448'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pickTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP}/json`, (r) => {
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
  const target = await pickTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise((r) => { ws.onopen = r })
  const ev = async (expression, timeout = 60000) => {
    const i = ++id
    const done = new Promise((resolve) => {
      pending.set(i, resolve)
      setTimeout(() => resolve({ timeout: true }), timeout)
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const m = await done
    if (m.timeout) throw new Error('evaluate timeout')
    return m.result?.result?.value
  }

  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
  // 确保回到首页再连接
  await ev(`(()=>{const b=[...document.querySelectorAll('.nav-item')].find(x=>x.innerText.trim()==='首页');if(b)b.click();return 1})()`)
  await sleep(500)
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r)r.click();return !!r})()`)
  let connected = false
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const t = await ev(`document.querySelector('.connect-ring')?.innerText||''`)
    if (String(t).includes('已连接')) { connected = true; break }
  }
  console.log('connected:', connected)
  if (!connected) process.exit(1)

  // 测量：每 250ms 发一次轻量命令，持续 12 秒
  const samples = await ev(`(async()=>{
    const invoke = window.__TAURI_INTERNALS__.invoke
    const out = []
    for (let i=0;i<48;i++) {
      const t0=performance.now()
      try { await invoke('core_status') } catch(e) {}
      out.push(Math.round(performance.now()-t0))
      await new Promise(r=>setTimeout(r,250))
    }
    return JSON.stringify(out)
  })()`, 90000)
  const arr = JSON.parse(samples)
  const max = Math.max(...arr)
  const slow = arr.filter((n) => n > 300).length
  console.log('core_status latency ms:', arr.join(','))
  console.log(`max=${max}ms >300ms=${slow}/48`)

  // 断开
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r)r.click();return !!r})()`)
  await sleep(6000)
  process.exit(0)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

const http = require('http')
const { execFileSync } = require('child_process')

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

;(async () => {
  const target = await pageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await new Promise((r) => { ws.onopen = r })
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return m.result?.result?.value
  }

  const notice = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return !!b})()`)

  const trigger = await ev(`!!document.querySelector('.proto-trigger')`)
  await ev(`document.querySelector('.proto-trigger')?.click()`)
  await sleep(200)
  const menuItems = await ev(`[...document.querySelectorAll('.proto-option')].map(x=>x.innerText.trim())`)
  await ev(`(()=>{const b=[...document.querySelectorAll('.proto-option')].find(x=>x.innerText.includes('MASQUE H3'));if(b)b.click();return !!b})()`)
  await sleep(200)
  const selectedProto = await ev(`document.querySelector('.proto-value')?.innerText.trim()`)

  const themeBefore = await ev(`document.documentElement.dataset.theme`)
  await ev(`document.querySelectorAll('.icon-btn')[0]?.click()`)
  await sleep(250)
  const themeAfter = await ev(`document.documentElement.dataset.theme`)
  const langBefore = await ev(`document.documentElement.lang`)
  await ev(`document.querySelectorAll('.icon-btn')[1]?.click()`)
  await sleep(250)
  const langAfter = await ev(`document.documentElement.lang`)
  const iconCount = await ev(`document.querySelectorAll('.icon-btn').length`)

  await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 760, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  const narrow = JSON.parse(await ev(`JSON.stringify((()=>{const c=document.querySelector('.home-connect-card');const o=document.querySelector('.home-options');return {cardOverflow:c?c.scrollWidth-c.clientWidth:-1,optOverflow:o?o.scrollWidth-o.clientWidth:-1,cols:c?getComputedStyle(c).gridTemplateColumns:''}})())`))
  await send('Emulation.clearDeviceMetricsOverride')

  const connected = await ev(`!!document.querySelector('.connect-ring.connected')`)
  if (!connected) await ev(`document.querySelector('.connect-ring')?.click()`)
  let ringConnected = connected
  for (let i = 0; i < 40 && !ringConnected; i++) {
    await sleep(1000)
    ringConnected = await ev(`!!document.querySelector('.connect-ring.connected')`)
  }
  if (ringConnected) {
    try {
      for (let i = 0; i < 3; i++) {
        execFileSync('curl.exe', ['-s', '--max-time', '15', '-x', 'http://127.0.0.1:7890', 'https://www.cloudflare.com/cdn-cgi/trace'], { stdio: 'ignore', timeout: 20000 })
      }
    } catch { /* 流量生成失败时仍继续读取当前速率 */ }
  }
  await sleep(2500)
  const throughput = await ev(`(()=>{const cards=[...document.querySelectorAll('.card')];const c=cards.find(x=>x.innerText.includes('上传速率')||x.innerText.includes('Upload'));return c?c.innerText.replace(/\\n/g,' | '):''})()`)
  const speeds = [...(throughput || '').matchAll(/(\d+(?:\.\d+)?)\s?(B|KB|MB)\/s/g)]
  const speedSeen = speeds.some((m) => Number(m[1]) > 0)

  await ev(`window.AnTunDesktop?.coreStop?.(); document.querySelector('.connect-ring')?.click(); true`)

  console.log(JSON.stringify({
    noticeDismissed: notice,
    protocolTrigger: trigger,
    protocolMenuCount: menuItems.length,
    protocolMenuItems: menuItems,
    protocolSelected: selectedProto,
    iconCount,
    theme: `${themeBefore} -> ${themeAfter}`,
    lang: `${langBefore} -> ${langAfter}`,
    narrow,
    ringConnected,
    throughput: throughput.slice(0, 220),
    speedSeen,
  }, null, 2))
  ws.close()
})().catch((e) => { console.error(e); process.exit(1) })

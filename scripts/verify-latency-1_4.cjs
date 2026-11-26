/** 验证实时延迟波形图上的具体毫秒数（连接后采样） */
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
  const ev = async (expression) => {
    const i = ++id
    const done = new Promise((resolve) => pending.set(i, resolve))
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
  await click('首页')
  await sleep(300)

  const started = await ev(`(()=>{const r=document.querySelector('.connect-ring');if(!r)return false;if(!r.className.includes('connected'))r.click();return true})()`)
  let connected = false
  for (let i = 0; i < 60; i++) {
    connected = await ev(`!!document.querySelector('.connect-ring.connected')`)
    if (connected) break
    await sleep(1000)
  }

  let card = ''
  for (let i = 0; i < 30 && connected; i++) {
    card = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('实时延迟'));return c?c.innerText.replace(/\\n/g,' | '):''})()`)
    if (/\d+\s*ms/.test(card)) break
    await sleep(1000)
  }

  await ev(`window.AnTunDesktop?.coreStop?.(); document.querySelector('.connect-ring')?.click(); true`)

  console.log(JSON.stringify({
    started,
    connected,
    latencyCard: card,
    showsMilliseconds: /\d+\s*ms/.test(card),
  }, null, 2))
  ws.close()
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

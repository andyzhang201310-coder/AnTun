/** 逐个切换 6 种协议并做真实连接验证（通过 CDP 操作已启动的 Tauri 窗口） */
const http = require('http')

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:9222${path}`, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

async function main() {
  const pages = await getJson('/json')
  const page = pages.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到应用页面')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise((r) => (ws.onopen = r))
  const ev = (expression) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, (m) => {
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.text))
      else resolve(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 回到首页，必要时先断开
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='首页');b?.click();return true})()`)
  await sleep(300)
  const state = () => ev(`JSON.stringify({connected:!!document.querySelector('.connect-ring.connected'),connecting:document.body.innerText.includes('连接中'),ip:(document.body.innerText.match(/\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b/)||[''])[0]})`)

  if (JSON.parse(await state()).connected) {
    await ev(`document.querySelector('.pwr')?.click()`)
    await sleep(1500)
  }

  const protocols = ['WireGuard', 'AWG', 'GOOL', 'MASQUE H3', 'MASQUE H2', 'MASQUE in MASQUE']
  const labels = await ev(`JSON.stringify([...document.querySelectorAll('.segment button')].map(b=>b.innerText.trim()))`)
  console.log('协议按钮:', labels)

  for (const name of protocols) {
    const picked = await ev(`(()=>{const b=[...document.querySelectorAll('.segment button')].find(x=>x.innerText.trim()===${JSON.stringify(name)});if(!b)return false;b.click();return true})()`)
    if (!picked) { console.log(`${name}: 未找到按钮`); continue }
    await sleep(200)
    await ev(`document.querySelector('.pwr')?.click()`)
    let result = null
    for (let i = 0; i < 35; i++) {
      await sleep(1000)
      result = JSON.parse(await state())
      if (result.connected && result.ip) break
    }
    console.log(`${name}:`, JSON.stringify(result))
    if (result.connected) {
      await ev(`document.querySelector('.pwr')?.click()`)
      await sleep(1500)
    }
  }
  ws.close()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

/** 通过 CDP 选择指定协议并连接，等待结果后输出状态 */
const http = require('http')

const target = process.argv[2] || 'MASQUE H3'
const waitMs = Number(process.argv[3] || 12000)

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
  const asObj = async (expression) => {
    const raw = await ev(expression)
    if (raw && typeof raw === 'object') return raw
    return JSON.parse(raw)
  }

  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='首页');b?.click();return true})()`)
  await sleep(300)
  const before = await asObj(`JSON.stringify({connected:!!document.querySelector('.connect-ring.connected')})`)
  if (before.connected) {
    await ev(`document.querySelector('.pwr')?.click()`)
    await sleep(1500)
  }
  const picked = await ev(`(()=>{const b=[...document.querySelectorAll('.segment button')].find(x=>x.innerText.trim()===${JSON.stringify(target)});if(!b)return false;b.click();return true})()`)
  if (!picked) throw new Error(`未找到协议按钮: ${target}`)
  await sleep(300)
  await ev(`document.querySelector('.pwr')?.click()`)
  let result = null
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(1000)
    result = await asObj(`JSON.stringify({connected:!!document.querySelector('.connect-ring.connected'),connecting:document.body.innerText.includes('连接中'),ip:(document.body.innerText.match(/\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b/)||[''])[0]})`)
    if (result.connected && result.ip) break
  }
  console.log(`${target}:`, JSON.stringify(result))
  if (result.connected) {
    await ev(`document.querySelector('.pwr')?.click()`)
    await sleep(1500)
  }
  ws.close()
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

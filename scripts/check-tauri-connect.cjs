/** 补测 Tauri 版连接完成态：点击电源按钮后分段观察 8 秒 */
const http = require('http')
const fs = require('fs')

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = ''
  res.on('data', (c) => { data += c })
  res.on('end', async () => {
    const page = JSON.parse(data).find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => { ws.onopen = r })
    let seq = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
    const cmd = (method, params = {}) => new Promise((r) => {
      const id = ++seq
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
    const ev = async (expression) => {
      const r = await cmd('Runtime.evaluate', { expression, returnByValue: true })
      return r.result?.result?.value
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='首页');b?.click();return true})()`)
    await sleep(400)
    console.log('BEFORE:', await ev(`document.querySelector('.pwr')?.innerText`))
    await ev(`document.querySelector('.pwr')?.click()`)
    for (const wait of [2000, 3000, 3000]) {
      await sleep(wait)
      const state = await ev(`JSON.stringify({ring:document.querySelector('.connect-ring')?.className,btn:document.querySelector('.pwr')?.innerText,ip:document.body.innerText.match(/\\d+\\.\\d+\\.\\d+\\.\\d+/)?.[0]||null,connected:document.body.innerText.includes('已连接')})`)
      console.log('AFTER +' + wait + 'ms:', state)
    }
    const shot = await cmd('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync('D:/VSCode/AnTun/tauri-connected.png', Buffer.from(shot.result.data, 'base64'))
    ws.close()
  })
}).on('error', (e) => { console.error('FATAL:', e.message); process.exit(1) })

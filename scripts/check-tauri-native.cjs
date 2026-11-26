/** 验证 Tauri 原生桥接：自启查询、托盘状态通知、退出命令注册 */
const http = require('http')

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = ''
  res.on('data', (c) => { data += c })
  res.on('end', async () => {
    const page = JSON.parse(data).find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => { ws.onopen = r })
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id === 1) {
        console.log('NATIVE BRIDGE:', m.result?.result?.value)
        ws.close()
      }
    }
    const expression = `(async()=>{const d=window.AnTunDesktop;try{const a=await d.getAutoStart();await d.notifyStatus(true);return JSON.stringify({autostartQuery:a,trayNotify:'ok',quitRegistered:typeof d.onQuitRequest==='function'})}catch(e){return JSON.stringify({error:String(e)})}})()`
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
}).on('error', (e) => { console.error('FATAL:', e.message); process.exit(1) })

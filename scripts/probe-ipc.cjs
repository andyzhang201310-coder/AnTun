const http = require('http')
http.get('http://127.0.0.1:9222/json', (r) => {
  let d = ''
  r.on('data', (c) => (d += c))
  r.on('end', () => {
    const p = JSON.parse(d).find((t) => t.type === 'page' && t.url.includes('tauri'))
    const ws = new WebSocket(p.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result?.result?.value); pending.delete(m.id) }
    }
    const ev = (expression) => new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    ws.onopen = async () => {
      console.log('coreStatus:', await ev(`window.AnTunDesktop.coreStatus().then(x=>JSON.stringify(x)).catch(e=>'ERR:'+e)`))
      console.log('loadCredential:', await ev(`window.AnTunDesktop.loadCredential().then(x=>JSON.stringify(x)).catch(e=>'ERR:'+e)`))
      console.log('probeStatus:', await ev(`window.AnTunDesktop.probeStatus(7890).then(x=>JSON.stringify(x)).catch(e=>'ERR:'+e)`))
      ws.close()
    }
  })
})

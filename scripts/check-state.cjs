const http = require('http')
http.get('http://127.0.0.1:9222/json', (r) => {
  let d = ''
  r.on('data', (c) => (d += c))
  r.on('end', () => {
    const p = JSON.parse(d).find((t) => t.type === 'page' && t.url.includes('tauri'))
    const ws = new WebSocket(p.webSocketDebuggerUrl)
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `JSON.stringify({
          text: document.body.innerText.slice(0, 1500),
          ring: document.querySelector('.connect-ring')?.className || '',
          pwr: document.querySelector('.pwr')?.innerText || '',
          logs: [...document.querySelectorAll('.log-line, .log-row, [class*=log]')].slice(-8).map(x=>x.innerText)
        })`,
        returnByValue: true,
      },
    }))
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id === 1) { console.log(m.result.result.value); ws.close() }
    }
  })
})

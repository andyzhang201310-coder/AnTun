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
  const page = pages.find((t) => t.type === 'page' && t.url.includes('tauri'))
  if (!page) throw new Error('未找到应用页面')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))

  const evaluate = (expression) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, (m) => {
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.text))
      else resolve(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })

  console.log('1) 窗口尺寸:', await evaluate(`JSON.stringify({w:outerWidth,h:outerHeight,title:document.title})`))

  // 关闭许可弹窗
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='确定');if(b)b.click();return !!b})()`)
  await new Promise((r) => setTimeout(r, 500))

  // 检查桥接与内置凭证
  console.log('2) 桌面桥接:', await evaluate(`JSON.stringify({desktop:!!window.AnTunDesktop?.isDesktop,tauri:!!window.AnTunDesktop?.isTauri})`))

  // 点击连接圆环
  const clicked = await evaluate(`(()=>{const p=document.querySelector('.pwr');if(p){p.click();return true}return false})()`)
  console.log('3) 点击连接:', clicked)

  // 等待真实连接（最多 40 秒）
  let state = null
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    state = JSON.parse(await evaluate(`JSON.stringify((()=>{const t=document.body.innerText;const m=t.match(/\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b/);return{connected:t.includes('已连接')||!!document.querySelector('.connect-ring.connected'),exit:m?m[0]:'',failed:t.includes('连接失败')||t.includes('错误'),ring:document.querySelector('.connect-ring')?.className||''}})())`))
    if (state.connected && state.exit) break
  }
  console.log('4) 连接状态:', JSON.stringify(state))

  // 通过页面 fetch 验证 YouTube（经系统代理需 curl，这里用 Rust core 的探测结果佐证）
  console.log('5) 页面可见出口:', await evaluate(`JSON.stringify((document.body.innerText.match(/\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b/)||[''])[0])`))

  ws.close()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

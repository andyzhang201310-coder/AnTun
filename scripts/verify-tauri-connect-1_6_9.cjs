/** 1.6.9 真机连接验证：节点出口订阅模式下会话标签应为 VLESS · 节点出口，随后断开还原代理 */
const http = require('http')
const fs = require('fs')
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const page = (await getJson('http://127.0.0.1:9335/json')).find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq
    pend.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result?.value
  }
  await send('Runtime.enable', {})
  const state = () => ev(`(()=>{const r=document.querySelector('.connect-ring');const t=r?r.innerText.replace(/\\n/g,'|'):'';
    if(/已连接/.test(t))return 'connected';if(/正在连接/.test(t))return 'connecting';return 'idle'})()`)

  await ev(`(()=>{document.querySelector('.connect-ring').click();return 1})()`)
  let st = 'connecting'
  for (let i = 0; i < 40; i++) { await sleep(2000); st = await state(); if (st !== 'connecting') { console.log(`连接耗时 ~${(i + 1) * 2}s → ${st}`); break } }
  if (st !== 'connected') {
    const tail = await ev(`(()=>{const l=JSON.parse(localStorage.getItem('antun-prefs')||'{}');return (l.state?.logs||[]).slice(-6).map(x=>x.level+' '+x.message).join(' || ')})()`)
    console.log('连接失败，日志:', tail)
  } else {
    const stats = await ev(`(()=>{const cards=Array.from(document.querySelectorAll('.card')).slice(0,4).map(c=>c.innerText.replace(/\\n/g,' | '));return cards.join(' ### ')})()`)
    console.log('状态卡:', stats)
    fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-169-connected.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await ev(`(()=>{document.querySelector('.connect-ring').click();return 1})()`)
    await sleep(5000)
    console.log('断开后状态:', await state())
  }
  ws.close()
})()

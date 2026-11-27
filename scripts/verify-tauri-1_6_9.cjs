/**
 * 1.6.9 真机验收（读取用户本机真实设置，不建隧道）：
 * 顶栏一行标题 + 第二行免责声明；订阅节点出口时协议框只读显示节点协议。
 */
const http = require('http')
const fs = require('fs')
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const list = await getJson('http://127.0.0.1:9335/json')
  const page = list.find((t) => t.type === 'page')
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
  await send('Page.enable', {})
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

  // 关闭启动须知弹窗（只影响本机 seen 标记）
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/确定|OK/.test(x.textContent||''));if(b)b.click();return 1})()`)
  await sleep(1500)

  const s = JSON.parse(await ev(`(()=>{const raw=JSON.parse(localStorage.getItem('antun-prefs')||'{}');const st=raw.state||raw;const g=st.settings||{};
    return JSON.stringify({page:st.page,connMode:g.connMode,subExit:g.subExit,subViaWarp:g.subViaWarp,proto:g.proto,frontNodeId:g.frontNodeId,nodes:(st.subNodes||[]).length,node:(st.subNodes||[]).find(n=>n.id===g.frontNodeId)||null})})()`))
  console.log('本机设置:', JSON.stringify(s).slice(0, 400))

  const head = JSON.parse(await ev(`(()=>{const t=document.querySelector('.section-title'),su=document.querySelector('.section-sub-inline'),n=document.querySelector('.section-notice');
    if(!t||!su||!n)return JSON.stringify({miss:true});
    const tr=t.getBoundingClientRect(),sr=su.getBoundingClientRect(),nr=n.getBoundingClientRect();
    return JSON.stringify({title:t.innerText,sub:su.innerText,notice:n.innerText,sameLine:Math.abs((tr.top+tr.bottom)/2-(sr.top+sr.bottom)/2)<8,noticeBelow:nr.top>sr.bottom-2})})()`))
  console.log('顶栏:', JSON.stringify(head))

  const proto = JSON.parse(await ev(`(()=>{const box=document.querySelector('.proto-select');if(!box)return JSON.stringify({miss:true});
    const btn=box.querySelector('.proto-trigger');
    return JSON.stringify({disabled:box.classList.contains('disabled')&&btn.disabled,value:box.querySelector('.proto-value')?.innerText,lock:box.querySelector('.proto-lock')?.innerText||'',label:box.querySelector('.proto-label')?.innerText})})()`))
  console.log('协议框:', JSON.stringify(proto))

  fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-169-tauri.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  ws.close()
})()

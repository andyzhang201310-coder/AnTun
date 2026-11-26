/** 真实调用内核更新命令：node verify-core-update-live-1_3.cjs [mihomo|psiphon] */
const http = require('http')

const kind = process.argv[2] || 'mihomo'

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

  const before = await ev(`(async()=>await window.AnTunDesktop.coreUpdateStatus())()`)
  const result = await ev(`(async()=>{try{return await window.AnTunDesktop.coreUpdate(${JSON.stringify(kind)})}catch(e){return {ok:false,error:String(e?.message||e)}}})()`)
  const after = await ev(`(async()=>await window.AnTunDesktop.coreUpdateStatus())()`)

  console.log(JSON.stringify({ kind, before: before[kind], result, after: after[kind] }, null, 2))
  ws.close()
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

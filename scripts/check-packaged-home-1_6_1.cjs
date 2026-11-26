/**
 * 打包产物检查：确认安装后的应用首页含「出口节点」下拉框与新文案。
 * 只读：不改动任何持久化偏好。
 */
const http = require('http')

function pageTarget() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9444/json', (r) => {
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
  const ev = async (expression, timeout = 15000) => {
    const i = ++id
    const done = new Promise((resolve) => {
      pending.set(i, resolve)
      setTimeout(() => resolve({ timeout: true }), timeout)
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const m = await done
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text)
    return m.result?.result?.value
  }

  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();
    [...document.querySelectorAll('button')].find(x=>x.innerText.includes('跳过'))?.click();
    const home=[...document.querySelectorAll('nav button, aside button, .mobile-nav button')].find(x=>x.innerText.trim()==='首页');
    home?.click(); return 1})()`)
  await new Promise((r) => setTimeout(r, 1200))

  const info = await ev(`(()=>{
    const sel=document.querySelector('.home-options select');
    const label=[...document.querySelectorAll('.home-options span')].map(x=>x.innerText.trim()).find(x=>x==='出口节点');
    return {
      hasSelect: !!sel,
      optionCount: sel ? sel.options.length : 0,
      hasLabel: !!label,
      badge: [...document.querySelectorAll('.home-options .badge')].map(x=>x.innerText.trim()),
      hint: sel ? sel.parentElement.innerText.replace(/\\n/g,' / ') : null,
      desktop: !!(window).AnTunDesktop
    }
  })()`)
  console.log(JSON.stringify(info, null, 1))
  const ok = info.hasSelect && info.hasLabel && info.badge.includes('WARP 直连')
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

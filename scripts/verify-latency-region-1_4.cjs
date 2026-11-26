/** 验证 1.4.0：实时延迟数值 + Psiphon 出口地区（XEHN 兼容） */
const http = require('http')
const fs = require('fs')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const click = (text) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`)

  await ev(`localStorage.setItem('antun-notice-seen','1'); true`)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return true})()`)
  await ev(`document.querySelector('.btn-block')?.click(); true`)
  await sleep(300)
  await ev(`(async()=>{for(let i=0;i<3;i++){if((document.documentElement.lang||'').startsWith('zh'))break;document.querySelectorAll('.icon-btn')[1]?.click();await new Promise(r=>setTimeout(r,180));}return document.documentElement.lang})()`)
  await click('首页')
  await sleep(300)

  await click('扫描端点')
  let latencyCard = ''
  for (let i = 0; i < 45; i++) {
    latencyCard = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('实时延迟'));return c?c.innerText.replace(/\\n/g,' | '):''})()`)
    if (/\d+\s*ms/.test(latencyCard)) break
    await sleep(1000)
  }

  await click('设置')
  await sleep(300)
  await ev(`(()=>{const row=[...document.querySelectorAll('.field-row')].find(x=>x.innerText.includes('Psiphon 出口'));const b=row?.querySelector('[role="switch"]');if(b&&b.getAttribute('aria-pressed')!=='true')b.click();return true})()`)
  await sleep(300)

  await ev(`(()=>{const s=[...document.querySelectorAll('select.select')].find(x=>[...x.options].some(o=>o.value==='US'));if(!s)return false;const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,'US');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await sleep(500)

  const result = await ev(`JSON.stringify((()=>{const s=[...document.querySelectorAll('select.select')].find(x=>[...x.options].some(o=>o.value==='US'));const text=document.body.innerText;return {
    latencyCard:${JSON.stringify(latencyCard)},
    latencyHasValue:/\\d+\\s*ms/.test(${JSON.stringify(latencyCard)}),
    regionOptionCount:s?s.options.length:-1,
    regionFirst:s?s.options[0].innerText.trim():'',
    hasUS:s?[...s.options].some(o=>o.innerText.includes('美国')&&o.value==='US'):false,
    regionDisabled:s?s.disabled:null,
    saved:text.includes('出口地区已保存')
  }})())`)

  const appInfo = await ev(`(async()=>await window.AnTunDesktop.appInfo())()`)
  const cfgPath = path.join(appInfo.dataDir, 'client.config')
  let egressRegion = null
  try {
    egressRegion = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).EgressRegion
  } catch (e) {
    egressRegion = `READ_FAILED: ${e.message}`
  }

  console.log(JSON.stringify({ ...JSON.parse(result), cfgPath, egressRegion }, null, 2))
  ws.close()
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

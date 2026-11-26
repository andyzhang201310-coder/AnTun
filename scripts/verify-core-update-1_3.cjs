/** 验证 1.3.0：关于页清理 + 设置页内核更新入口与命令注册 */
const http = require('http')

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
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text)
    return m.result?.result?.value
  }
  const click = (text) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`)

  await ev(`localStorage.setItem('antun-notice-seen','1'); true`)
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return true})()`)
  await ev(`document.querySelector('.btn-block')?.click(); true`)
  await sleep(300)

  // 固定中文，避免上次验证遗留的英文偏好影响文案断言
  await ev(`(async()=>{for(let i=0;i<3;i++){if((document.documentElement.lang||'').startsWith('zh'))break;document.querySelectorAll('.icon-btn')[1]?.click();await new Promise(r=>setTimeout(r,180));}return document.documentElement.lang})()`)

  await click('关于')
  await sleep(400)
  const about = await ev(`JSON.stringify((()=>{const text=document.body.innerText;const card=[...document.querySelectorAll('.card')].find(c=>c.innerText.includes('相关链接'));return {
    forbidden:['版本、路径与许可证','程序路径','资源目录','数据目录','参考项目 XEHN','控制码','MIT'].filter(x=>text.includes(x)),
    hasAnTun: text.includes('AnTun'),
    linkCount: card ? card.querySelectorAll('a').length : -1,
    linkUrls: card ? [...card.querySelectorAll('a')].map(a=>a.getAttribute('href')) : [],
  }})())`)
  const aboutResult = JSON.parse(about)

  await click('设置')
  await sleep(400)
  const settings = await ev(`JSON.stringify((()=>{const text=document.body.innerText;const desk=window.AnTunDesktop||{};return {
    hasCoreCard:text.includes('内核更新'),
    hasMihomo:text.includes('mihomo 核心'),
    hasPsiphon:text.includes('Psiphon 核心'),
    updateButtons:[...document.querySelectorAll('button')].filter(b=>b.innerText.includes('检查并更新')).length,
    statusMethod:typeof desk.coreUpdateStatus,
    updateMethod:typeof desk.coreUpdate,
  }})())`)
  const settingsResult = JSON.parse(settings)

  const status = await ev(`(async()=>await window.AnTunDesktop.coreUpdateStatus())()`)
  const invalidKind = await ev(`(async()=>{try{await window.AnTunDesktop.coreUpdate('invalid');return 'unexpected-success'}catch(e){return String(e?.message||e)}})()`)

  console.log(JSON.stringify({
    about: aboutResult,
    settings: settingsResult,
    status,
    invalidKind,
  }, null, 2))
  ws.close()
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

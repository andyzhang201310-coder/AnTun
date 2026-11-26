/** 验证三项改动：首页按钮、订阅模式、关于页信息 */
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
  const page = pages.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到应用页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise((r) => (ws.onopen = r))
  const ev = (expression) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, (m) => {
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.text))
      else resolve(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const obj = async (expr) => {
    const raw = await ev(expr)
    return raw && typeof raw === 'object' ? raw : JSON.parse(raw)
  }
  const click = (text) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`)

  await ev(`localStorage.setItem('antun-notice-seen','1'); true`)
  await ev(`document.querySelector('.btn-block')?.click(); true`)
  await sleep(300)
  await click('首页')
  await sleep(300)

  const home = await obj(`JSON.stringify({
    ring:!!document.querySelector('.connect-ring'),
    connectButtons:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(x=>x==='连接'||x==='断开'||x==='Connect'||x==='Disconnect'),
    scanButton:[...document.querySelectorAll('button')].some(b=>b.innerText.includes('扫描端点'))
  })`)

  await click('模式')
  await sleep(300)
  await click('订阅模式')
  await sleep(300)
  const navModes = (await ev(`document.body.innerText`)).includes('连接模式')
  await ev(`(()=>{const e=document.querySelector('textarea.input');if(!e)return false;const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,'http://127.0.0.1:8899/test-subscription.yaml');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await sleep(200)
  await click('导入订阅')
  await sleep(2500)
  const modesText = await ev(`document.body.innerText`)
  const subscription = {
    navModes,
    imported: modesText.includes('导入成功') || modesText.includes('Test SOCKS'),
    hasNode: modesText.includes('Test SOCKS') && modesText.includes('127.0.0.1:1080'),
    hasSelected: modesText.includes('当前前置'),
  }

  await click('关于')
  await sleep(400)
  const aboutText = await ev(`document.body.innerText`)
  const about = {
    hasAnTunLicense: aboutText.includes('MIT') && aboutText.includes('mihomo'),
    hasPaths: aboutText.includes('程序路径') && aboutText.includes('数据目录'),
    noOldLicense: !aboutText.includes('GPL-3.0 · MIT'),
    noXehnReleaseLink: !aboutText.includes('/xehn/releases'),
    showsReference: aboutText.includes('参考项目 XEHN'),
  }

  console.log(JSON.stringify({ home, subscription, about }, null, 2))
  ws.close()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

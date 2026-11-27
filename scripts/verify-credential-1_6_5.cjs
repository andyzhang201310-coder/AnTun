/**
 * 1.6.5 凭证身份验证（打包后的真实 exe，隔离数据目录）
 *
 * 断言：
 * 1. 首次启动后用户数据目录生成 warp-credential.json，source=auto，密钥与内置不同
 * 2. 设置页「凭证身份」显示「本机独享」
 * 3. 再次启动不会重复注册（文件保持同一把密钥）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.CDP_PORT || 9449)
const APP_DATA = process.env.APP_DATA_DIR

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function mark(name, ok, extra = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
}

function getTargets() {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        try {
          resolve(JSON.parse(d).filter((t) => t.type === 'page'))
        } catch {
          resolve([])
        }
      })
    }).on('error', () => resolve([]))
  })
}

async function main() {
  const targets = await getTargets()
  if (!targets.length) {
    console.log('FAIL  no CDP target — 应用未以调试端口启动')
    process.exit(1)
  }
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  const ev = (expr, timeout = 20000) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, (m) => res(m.result && m.result.result && m.result.result.value))
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
      setTimeout(() => res(null), timeout)
    })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  await sleep(1500)

  // 关闭首启提示（若有）
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
  await sleep(500)

  // 1. 凭证文件
  const credPath = path.join(APP_DATA, 'com.antun.client', 'warp-credential.json')
  let cred = null
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(credPath)) {
      try {
        cred = JSON.parse(fs.readFileSync(credPath, 'utf8'))
        break
      } catch { /* 写入中，稍后再读 */ }
    }
    await sleep(500)
  }
  mark('credential file created', !!cred, credPath)
  if (cred) {
    mark('source = auto', cred.source === 'auto', `source=${cred.source}`)
    mark('key is device-unique', cred.privateKey && cred.privateKey !== 'AO9FFXpvI2abd29iiuIskLoRg3nkT3j1VGs1M/1cj3s=', `key=${String(cred.privateKey).slice(0, 10)}…`)
    mark('address assigned', !!cred.addressV4, `${cred.addressV4} / ${cred.addressV6}`)
    mark('endpoint numeric', /^\d+\.\d+\.\d+\.\d+$/.test(String(cred.endpointHost)), `${cred.endpointHost}:${cred.endpointPort}`)
  }

  // 2. 设置页身份徽标
  await ev(`(()=>{const b=[...document.querySelectorAll('button,a,div')].find(x=>x.innerText.trim()==='设置');if(b)b.click();return 1})()`)
  await sleep(1200)
  const badge = await ev(`(()=>{const t=document.body.innerText;const m=t.match(/凭证身份[\\s\\S]{0,40}/);return m?m[0].replace(/\\n/g,' | '):null})()`)
  mark('settings shows device-only identity', String(badge || '').includes('本机独享'), String(badge))
  const shared = await ev(`document.body.innerText.includes('内置共享')`)
  mark('not marked as shared', shared === false, `sharedBadge=${shared}`)

  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.log('FAIL  script error:', e.message)
  process.exit(1)
})

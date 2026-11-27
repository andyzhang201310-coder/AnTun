/**
 * 1.6.5 前端验证：设置页「凭证身份」徽标
 *
 * 用桩替换桌面桥接（不碰真实核心/系统代理/注册接口），分别模拟：
 * 1) 本机独享身份（source=auto）→ 徽标应为「本机独享」
 * 2) 内置共享身份（source=builtin）→ 徽标应为「内置共享」
 */
const http = require('http')

const CDP = process.env.CDP_PORT || '9450'
const PORT = process.env.PREVIEW_PORT || '4603'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pageTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP}/json`, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        const list = JSON.parse(d)
        const p = list.find((t) => t.type === 'page' && t.url.includes(PORT)) || list.find((t) => t.type === 'page')
        p ? resolve(p) : reject(new Error('no page target'))
      })
    }).on('error', reject)
  })
}

const prefs = (mode) => ({
  state: {
    settings: { connMode: 'warp', lang: 'zh', theme: 'light', proto: 'awg' },
    page: 'settings',
    pinnedId: null,
    allowedCountries: [],
    subscriptions: [],
    subNodes: [],
  },
  version: mode,
})

const stub = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)}
  window.__credMode = mode
  window.AnTunDesktop = {
    isDesktop: true,
    isTauri: true,
    platform: 'windows',
    appInfo: async () => ({ version: '1.6.5', platform: 'windows', os: 'Windows', arch: 'x86_64', dataDir: 'C:/tmp' }),
    setAutoStart: async () => true,
    getAutoStart: async () => false,
    loadCredential: async () => ({ privateKey: 'x', peerPublicKey: 'y', addressV4: '172.16.0.2', addressV6: '', endpointHost: '162.159.192.1', endpointPort: 2408, source: mode === 'auto' ? 'auto' : '' }),
    saveCredential: async () => {},
    credentialInfo: async () => mode === 'auto'
      ? { source: 'auto', unique: true, addressV4: '172.16.0.3', addressV6: '2606:4700:110:8531:b24:c2f5:2473:a6b2', endpoint: '162.159.192.10:2408' }
      : { source: 'builtin', unique: false, addressV4: '172.16.0.2', addressV6: '2606:4700:110:8dcc:96d3:500e:c24b:9606', endpoint: '8.35.211.178:2408' },
    coreUpdateStatus: async () => ({ mihomo: { installed: true, version: 'v1.19.34', updatedAt: 0, source: 'bundled' }, psiphon: { installed: true, version: '1', updatedAt: 0, source: 'bundled' } }),
    psiphonRegions: async () => [],
    netDiagnose: async () => ({ ok: true, kind: 'dns', items: [], summary: '' }),
    notifyStatus: async () => {},
    coreConnect: async () => ({ ok: false, error: 'stub' }),
    coreStop: async () => {},
    coreTraffic: async () => ({ up: 0, down: 0, upTotal: 0, downTotal: 0 }),
    probeStatus: async () => ({ ok: false, error: 'stub' }),
    quit: async () => {},
  }
})()`

async function main() {
  const target = await pageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result && r.result.result && r.result.result.value
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
    }
  }
  await new Promise((r) => (ws.onopen = r))

  const results = []
  const mark = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)

  await send('Page.enable', {})
  for (const mode of ['auto', 'builtin']) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: stub(mode) })
    await ev(`localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify(prefs(mode)))}); localStorage.setItem('antun-notice-seen','1'); true`)
    await send('Page.reload', {})
    await sleep(3000)
    // 若底部有提示条，先关掉
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
    await sleep(300)

    const text = String(await ev('document.body.innerText'))
    if (mode === 'auto') {
      mark('auto identity shows 本机独享', text.includes('本机独享'), text.match(/凭证身份[\s\S]{0,30}/)?.[0]?.replace(/\n/g, ' | '))
      mark('auto identity shows assigned endpoint', text.includes('162.159.192.10:2408'))
    } else {
      mark('builtin identity shows 内置共享', text.includes('内置共享'))
      mark('builtin identity shows legacy endpoint', text.includes('8.35.211.178:2408'))
    }
  }

  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
}

main().catch((e) => {
  console.log('FAIL  script error:', e.message)
  process.exit(1)
})

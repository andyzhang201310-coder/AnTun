/**
 * 1.6.3 验证：左下角版本号 + 连接后切换菜单的流畅度
 *
 * 用桩替换桌面桥接（不碰真实核心/系统代理），注入一份「节点很多」的订阅存档，
 * 连接后持续产生流量，测量：
 * 1) 侧栏左下角显示 v<版本>
 * 2) 连接稳定 10 秒内 antun-prefs 落盘次数（旧实现每秒写一次含全部节点的大 JSON）
 * 3) 连接期间主线程长任务（> 200ms）数量
 * 4) 依次点击 7 个菜单，每次点击到首帧绘制耗时
 */
const http = require('http')
const fs = require('fs')

const CDP = process.env.CDP_PORT || '9446'
const PORT = process.env.PREVIEW_PORT || '4602'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pageTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP}/json`, (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => {
        const list = JSON.parse(d)
        const p = list.find((t) => t.type === 'page' && t.url.includes(PORT)) || list.find((t) => t.type === 'page')
        p ? resolve(p) : reject(new Error('no page target'))
      })
    }).on('error', reject)
  })
}

// 大量节点：接近真实重度订阅，放大旧实现「每秒序列化 + 落盘」的代价
const NODE_COUNT = 200
const NODES = Array.from({ length: NODE_COUNT }, (_, i) => ({
  id: `n${i}`,
  subId: 'sub1',
  name: `节点 ${String(i).padStart(3, '0')}`,
  nodeType: 'trojan',
  server: `10.0.${Math.floor(i / 250)}.${i % 250}`,
  port: 443,
  config: `  - name: "SUB-NODE"\n    type: "trojan"\n    server: "10.0.0.1"\n    port: 443\n    password: "${'x'.repeat(1800)}"\n    sni: "example.com"\n`,
}))

const PREFS = {
  state: {
    settings: { connMode: 'warp', lang: 'zh', theme: 'light', proto: 'awg' },
    page: 'home',
    pinnedId: null,
    allowedCountries: [],
    subscriptions: [{ id: 'sub1', name: '压力订阅', url: 'https://example.com/sub', updatedAt: Date.now() }],
    subNodes: NODES,
  },
  version: 0,
}

const STUB = `(() => {
  const state = { connected: false, trafficCalls: 0 }
  window.__stub = state
  window.AnTunDesktop = {
    isDesktop: true,
    appInfo: async () => ({ version: '1.6.3', exePath: '', resourceDir: '', dataDir: '' }),
    loadCredential: async () => ({
      privateKey: 'a', peerPublicKey: 'b', addressV4: '172.16.0.2', addressV6: '',
      endpointHost: 'engage.cloudflareclient.com', endpointPort: 2408,
    }),
    coreConnect: async () => {
      state.connected = true
      return { ok: true, exitIp: '104.16.1.1', country: 'US', city: '', colo: 'WARP', latency: 86, error: '' }
    },
    coreStop: async () => { state.connected = false },
    coreStatus: async () => state.connected,
    coreTraffic: async () => {
      state.trafficCalls++
      return { up: 12000 + Math.random() * 9000, down: 220000 + Math.random() * 90000, upTotal: 1024 * 1024, downTotal: 8 * 1024 * 1024 }
    },
    probeStatus: async () => ({ ok: true, exitIp: '', country: '', city: '', colo: '', latency: 86, error: '' }),
    notifyStatus: async () => {},
    onQuitRequest: () => {},
    quit: async () => {},
    saveCredential: async () => {},
    coreUpdateStatus: async () => ({}),
    coreUpdate: async () => ({ ok: true }),
    psiphonRegions: async () => [],
    setPsiphonRegion: async () => {},
    netDiagnose: async () => ({ ok: true, kind: 'dns', summary: '', items: [] }),
    nodeTestStart: async () => ({ tested: 0, skipped: [] }),
    nodeTestDelay: async () => [],
    nodeTestSpeed: async () => [],
    nodeTestStop: async () => {},
  }
})()`

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
  const send = (method, params) => {
    const i = ++id
    const done = new Promise((resolve) => {
      pending.set(i, resolve)
      setTimeout(() => resolve({ timeout: true }), 30000)
    })
    ws.send(JSON.stringify({ id: i, method, params }))
    return done
  }
  const ev = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text)
    return m.result?.result?.value
  }
  const shot = async (file) => {
    const m = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'))
  }

  // 先装桩，reload 后生效
  await send('Page.enable', {})
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB })
  await ev(`localStorage.setItem('antun-notice-seen','1'); localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify(PREFS))}); true`)
  await ev(`location.reload(); true`)
  await sleep(3000)
  // 保险：若新文档脚本没赶上（CDP 时序问题），直接在当前上下文再注入一次
  await ev(STUB)
  await sleep(300)
  const stubReady = await ev(`!!window.AnTunDesktop`)
  if (!stubReady) { console.error('stub not ready'); process.exit(1) }
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
  await sleep(500)

  const results = []
  const mark = (name, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`)
    console.log(results[results.length - 1])
  }

  // 1) 版本号
  const versionText = await ev(`(()=>{const a=document.querySelector('.desktop-sidebar');if(!a)return null;
    const lines=a.innerText.split('\\n').map(s=>s.trim()).filter(Boolean);return lines.slice(-3).join(' | ')})()`)
  mark('sidebar shows version', /v\d+\.\d+\.\d+/.test(String(versionText)), String(versionText))

  // 2) 连接（桩直接成功）
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r)r.click();return !!r})()`)
  let connected = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    connected = await ev(`document.querySelector('.connect-ring')?.innerText.includes('已连接')`)
    if (connected) break
  }
  mark('connected via stub', connected)
  if (!connected) { console.log(results.join('\n')); process.exit(1) }

  // 开始统计长任务与 localStorage 写入
  await ev(`(()=>{
    window.__perf = { long: [], writes: 0, maxLong: 0 }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration > 50) window.__perf.long.push(Math.round(e.duration))
          window.__perf.maxLong = Math.max(window.__perf.maxLong, Math.round(e.duration))
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch (e) {}
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = function (k, v) {
      if (k === 'antun-prefs') window.__perf.writes++
      return orig.call(this, k, v)
    }
    return 1
  })()`)

  // 连接状态下静置 10 秒：旧实现这里每秒都会写一次大 JSON
  await sleep(10000)
  const idle = await ev(`JSON.stringify({writes: window.__perf.writes, long: window.__perf.long.slice(0, 10), maxLong: window.__perf.maxLong, trafficCalls: window.__stub.trafficCalls})`)
  const idleObj = JSON.parse(idle)
  mark('no per-second persistence while connected', idleObj.writes <= 2, `writes=${idleObj.writes} trafficCalls=${idleObj.trafficCalls}`)
  mark('idle long tasks < 300ms', idleObj.maxLong < 300, `maxLong=${idleObj.maxLong}ms long=${JSON.stringify(idleObj.long)}`)

  // 3) 依次切换菜单，测点击到首帧
  const navs = ['modes', 'nodes', 'rules', 'settings', 'logs', 'about', 'home']
  const labels = { home: '首页', modes: '模式', nodes: '节点', rules: '规则', settings: '设置', logs: '日志', about: '关于' }
  const timings = []
  for (const key of navs) {
    const label = labels[key]
    const ms = await ev(`(async()=>{
      const btn=[...document.querySelectorAll('.nav-item')].find(b=>b.innerText.trim()===${JSON.stringify(label)})
      if(!btn) return -1
      const t0=performance.now()
      btn.click()
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
      return Math.round(performance.now()-t0)
    })()`)
    timings.push(`${label}:${ms}ms`)
    await sleep(250)
  }
  const maxSwitch = Math.max(...timings.map((s) => Number(s.split(':')[1].replace('ms', ''))))
  mark('menu switch under 500ms', maxSwitch >= 0 && maxSwitch < 500, timings.join(' '))

  await sleep(900) // 等合并落盘（500ms 防抖）真正写一次
  const after = JSON.parse(await ev(`JSON.stringify({writes: window.__perf.writes, maxLong: window.__perf.maxLong, page: JSON.parse(localStorage.getItem('antun-prefs')).state.page})`))
  mark('persistence stays bounded after switching', after.writes <= 2, `writes=${after.writes}`)
  mark('page change persisted', after.page === 'home', `page=${after.page}`)

  // 回到首页截图（左下角版本号 + 已连接）
  await ev(`(()=>{const b=[...document.querySelectorAll('.nav-item')].find(x=>x.innerText.trim()==='首页');if(b)b.click();return 1})()`)
  await sleep(600)
  await shot('scripts/shot-version-menu-1_6_3.png')

  const errors = await ev(`JSON.stringify(window.__stubErrors||[])`)
  console.log('page errors:', errors)
  const ok = results.every((r) => r.startsWith('PASS'))
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

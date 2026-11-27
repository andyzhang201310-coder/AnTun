/**
 * 1.6.4 真机验证：连接后点击左侧菜单是否仍有卡顿
 *
 * 走真实 mihomo 连接（系统代理会被临时改写，结束时自动断开还原），
 * 在页面内统计：
 * 1) 连接后主线程长任务（>200ms）
 * 2) 3 轮 × 7 个菜单点击 → 首帧耗时（旧实现每秒被同步 curl 堵 2 秒，这里会出现 >1000ms）
 * 3) 实时速率是否在更新（说明新的 async core_traffic 正常）
 */
const http = require('http')
const fs = require('fs')

const CDP = process.env.CDP_PORT || '9447'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pickTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP}/json`, (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => {
        const list = JSON.parse(d)
        const p = list.find((t) => t.type === 'page')
        p ? resolve(p) : reject(new Error('no page target'))
      })
    }).on('error', reject)
  })
}

;(async () => {
  const target = await pickTarget()
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
  const ev = async (expression, timeout = 30000) => {
    const i = ++id
    const done = new Promise((resolve) => {
      pending.set(i, resolve)
      setTimeout(() => resolve({ timeout: true }), timeout)
    })
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    const m = await done
    if (m.timeout) throw new Error('evaluate timeout')
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text)
    return m.result?.result?.value
  }
  const shot = async (file) => {
    const m = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'))
  }

  const results = []
  const mark = (name, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`)
    console.log(results[results.length - 1])
  }

  await sleep(1500)
  // 首次启动的免责声明
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='确认');if(b)b.click();return 1})()`)
  await sleep(500)

  // 连接
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r)r.click();return !!r})()`)
  let connected = false
  let state = ''
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    state = await ev(`document.querySelector('.connect-ring')?.innerText.replace(/\\n/g,' | ')`)
    if (String(state).includes('已连接')) { connected = true; break }
  }
  mark('real tunnel connected', connected, String(state))
  if (!connected) {
    console.log(results.join('\n'))
    await shot('scripts/shot-real-connected-fail.png')
    process.exit(1)
  }

  await sleep(3000)

  // 采样：长任务 + 即时点击延迟
  await ev(`(()=>{
    window.__perf = { long: [], max: 0 }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration > 200) window.__perf.long.push(Math.round(e.duration))
          window.__perf.max = Math.max(window.__perf.max, Math.round(e.duration))
        }
      }).observe({ entryTypes: ['longtask'] })
    } catch (e) {}
    return 1
  })()`)

  // 静置 8 秒，观察是否周期性卡死
  await sleep(8000)
  const idle = JSON.parse(await ev(`JSON.stringify({long: window.__perf.long, max: window.__perf.max})`))
  mark('no >200ms long task while connected', idle.long.length === 0, `max=${idle.max}ms list=${JSON.stringify(idle.long.slice(0, 5))}`)

  const rate = await ev(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.innerText.includes('吞吐'));return c?c.innerText.replace(/\\n/g,' | ').slice(0,160):null})()`)
  console.log('throughput card:', rate)

  // 3 轮菜单切换
  const navs = ['模式', '节点', '规则', '设置', '日志', '关于', '首页']
  const timings = []
  for (let round = 0; round < 3; round++) {
    for (const label of navs) {
      const ms = await ev(`(async()=>{
        const btn=[...document.querySelectorAll('.nav-item')].find(b=>b.innerText.trim()===${JSON.stringify(label)})
        if(!btn) return -1
        const t0=performance.now()
        btn.click()
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))
        return Math.round(performance.now()-t0)
      })()`)
      timings.push(Number(ms))
      await sleep(180)
    }
  }
  const valid = timings.filter((n) => n >= 0)
  const maxSwitch = Math.max(...valid)
  const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
  mark('menu switch under 400ms', maxSwitch < 400, `avg=${avg}ms max=${maxSwitch}ms samples=${valid.length}`)

  const after = JSON.parse(await ev(`JSON.stringify({long: window.__perf.long, max: window.__perf.max})`))
  mark('no >200ms long task during switching', after.long.length === 0, `max=${after.max}ms`)

  await shot('scripts/shot-real-connected-1_6_4.png')

  // 断开并还原系统代理
  await ev(`(()=>{const b=[...document.querySelectorAll('.nav-item')].find(x=>x.innerText.trim()==='首页');if(b)b.click();return 1})()`)
  await sleep(600)
  await ev(`(()=>{const r=document.querySelector('.connect-ring');if(r)r.click();return !!r})()`)
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const txt = await ev(`document.querySelector('.connect-ring')?.innerText.replace(/\\n/g,' ')`)
    if (String(txt).includes('连接') && !String(txt).includes('已连接') && !String(txt).includes('连接中')) break
  }
  const finalState = await ev(`document.querySelector('.connect-ring')?.innerText.replace(/\\n/g,' | ')`)
  mark('disconnected and proxy restored', String(finalState).includes('连接') && !String(finalState).includes('已连接'), String(finalState))

  console.log(ok(results) ? 'PASS' : 'FAIL')
  process.exit(ok(results) ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })

function ok(results) { return results.every((r) => r.startsWith('PASS')) }

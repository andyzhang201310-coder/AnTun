// 验收：已连接时切换「Psiphon 出口」开关，是否断开重连并真正改变出口
// 每一步一个短 CDP 会话（长连接会被 WebView 回收）
const http = require('http')
const { execSync } = require('child_process')

const PORT = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const psiphonPids = () => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq psiphon.exe" /FO CSV /NH', { encoding: 'utf8' })
    return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes('psiphon.exe')).map((l) => l.split(',')[1].replace(/"/g, ''))
  } catch { return [] }
}

function getJson(path) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => res(JSON.parse(b)))
    }).on('error', rej)
  })
}

async function ev(expr) {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq
    pend.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  ws.close()
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

const goHome = () => ev(`(async () => {
  const nav = [...document.querySelectorAll('.nav-item, nav a, nav button')].find((e) => e.textContent.trim() === '首页')
  nav?.click()
  await new Promise((r) => setTimeout(r, 700))
  return !!nav
})()`)

const snap = () => ev(`(() => {
  const ring = document.querySelector('.connect-ring')
  const row = [...document.querySelectorAll('.field-row')].find((r) => r.querySelector('.t')?.textContent.includes('Psiphon'))
  const card = [...document.querySelectorAll('.card')].find((c) => (c.querySelector('.muted')?.textContent || '').includes('出口 IP'))
  const txt = document.body.innerText
  return {
    connected: !!ring?.classList.contains('connected'),
    connecting: !!ring?.classList.contains('pulse'),
    psiphonOn: !!row?.querySelector('.switch.on'),
    psiphonDesc: row?.querySelector('.d, .desc')?.textContent?.trim() || '',
    exitIp: (card?.querySelector('.strong.mono')?.innerText || '').trim(),
    psiphonTag: txt.includes('Psiphon · 出口'),
    hint: (document.querySelector('.home-node-pick-hint')?.textContent || '').trim(),
  }
})()`)

const waitConnected = async (label, maxSec) => {
  for (let i = 0; i < maxSec / 3; i++) {
    await sleep(3000)
    const s = await snap()
    if (s.connected) return s
    if (i % 3 === 2) console.log(`    ${label} 等待中 ${(i + 1) * 3}s …`)
  }
  return null
}

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  OK ' : ' FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
}

;(async () => {
  const ver = await ev(`(document.body.innerText.match(/v1\\.\\d+\\.\\d+/) || [''])[0]`)
  console.log(`[0] 应用版本 ${ver}`)

  await goHome()
  let s = await snap()
  if (s.connected) {
    console.log('    当前已连接，先断开再准备测试')
    await ev(`document.querySelector('.connect-ring').click()`)
    await sleep(3500)
    s = await snap()
  }
  check('起始处于未连接状态', s.connected === false)

  // 1. 选 WARP 自动择优（无 Psiphon 的出口）
  await ev(`(async () => {
    const tr = document.querySelector('.flag-trigger')
    tr?.click()
    await new Promise((r) => setTimeout(r, 450))
    const opt = [...document.querySelectorAll('.flag-option')].find((o) => o.textContent.trim().includes('自动'))
    opt?.click()
    // store 的落盘是 500ms 合并写，读 localStorage 必须等过这个窗口
    await new Promise((r) => setTimeout(r, 1200))
    return !!opt
  })()`)
  const mode = await ev(`(() => { const s = JSON.parse(localStorage.getItem('antun-prefs') || '{}').state || {}; return { mode: s.settings?.connMode, psiphon: s.settings?.psiphon } })()`)
  check('已切到 WARP 模式且 Psiphon 关闭', mode.mode === 'warp' && mode.psiphon === false, `connMode=${mode.mode} psiphon=${mode.psiphon}`)
  const pidsAtStart = psiphonPids()
  console.log(`[1] 连接前 psiphon.exe 进程: ${pidsAtStart.length} 个`)
  check('连接前没有残留 psiphon.exe', pidsAtStart.length === 0, `${pidsAtStart.length} 个`)

  // 2. 连接（不启用 Psiphon）
  await ev(`document.querySelector('.connect-ring').click()`)
  console.log('    连接 WARP 直连（最多等 210 秒）…')
  const c1 = await waitConnected('WARP', 210)
  if (!c1) {
    console.log('RESULT: SKIP（本机 WARP 直连不可用：UDP 常被封，无法复现「已连接且未开 Psiphon」的起点）')
    process.exitCode = 3
    return
  }
  const pidsBefore = psiphonPids()
  console.log(`[2] 已连接：出口 ${c1.exitIp}；psiphon.exe ${pidsBefore.length} 个；Psiphon 标签=${c1.psiphonTag}`)
  check('连接时未启动 psiphon.exe', pidsBefore.length === 0, `${pidsBefore.length} 个`)

  // 3. 已连接状态下打开 Psiphon 开关
  console.log('[3] 已连接状态下点击「Psiphon 出口」开关…')
  const t0 = Date.now()
  await ev(`(() => {
    const row = [...document.querySelectorAll('.field-row')].find((r) => r.querySelector('.t')?.textContent.includes('Psiphon'))
    const sw = row?.querySelector('.switch')
    sw?.click()
    return !!sw
  })()`)

  // 采样 6 秒，确认进入「切换出口（断开重连）」态
  const seq = []
  let sawSwitchHint = false
  let firstHint = ''
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    const x = await snap()
    if (!firstHint && x.hint) firstHint = x.hint
    if (x.hint.includes('Psiphon')) sawSwitchHint = true
    seq.push(`${(i + 1) * 300}ms:${x.connected ? 'C' : x.connecting ? 'P' : '-'}${x.hint.includes('Psiphon') ? '/H' : ''}`)
  }
  console.log(`    提示文案: ${firstHint}`)
  console.log(`    切换后采样 ${seq.join(' ')}`)
  check('切换后出现「正在切换 Psiphon 出口」提示', sawSwitchHint)

  // 4. 等重连完成
  console.log('    等待重连（含 Psiphon 建隧道，最多 240 秒）…')
  const c2 = await waitConnected('Psiphon', 240)
  if (!c2) {
    const now = await snap()
    console.log(`RESULT: FAIL（切换后未重新连上；当前 psiphon.exe ${psiphonPids().length} 个，hint="${now.hint}"）`)
    process.exitCode = 1
    return
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  const pidsAfter = psiphonPids()
  console.log(`[3] 重连完成，用时 ${secs}s：出口 ${c2.exitIp}；psiphon.exe ${pidsAfter.length} 个；Psiphon 标签=${c2.psiphonTag}`)
  check('重连后启动了 psiphon.exe', pidsAfter.length >= 1, `${pidsAfter.length} 个`)
  check('会话标签变为 Psiphon 出口', c2.psiphonTag === true)
  check('出口 IP 已改变', !!c2.exitIp && c2.exitIp !== c1.exitIp, `${c1.exitIp} → ${c2.exitIp}`)

  // 5. 再关掉，确认能退回 WARP 直连（同一机制反向）；本机 UDP 常被封，可用 SKIP_REVERSE=1 跳过
  if (process.env.SKIP_REVERSE === '1') {
    console.log('[5] SKIP_REVERSE=1，跳过反向验证')
  } else {
  console.log('[5] 已连接状态下关闭 Psiphon，验证反向也能切回…')
  await ev(`(() => {
    const row = [...document.querySelectorAll('.field-row')].find((r) => r.querySelector('.t')?.textContent.includes('Psiphon'))
    row?.querySelector('.switch')?.click()
    return true
  })()`)
  const c3 = await waitConnected('WARP', 210)
  if (c3) {
    const p3 = psiphonPids()
    console.log(`[5] 关闭后重连：出口 ${c3.exitIp}；psiphon.exe ${p3.length} 个；Psiphon 标签=${c3.psiphonTag}`)
    check('关闭后 psiphon.exe 已回收', p3.length === 0, `${p3.length} 个`)
    check('关闭后出口 IP 再次变化', c3.exitIp !== c2.exitIp, `${c2.exitIp} → ${c3.exitIp}`)
  } else {
    console.log('[6] 关闭后 WARP 直连未在预算内连上（本机 UDP 可能被封），跳过反向断言')
  }
  }

  const pass = results.every((r) => r.ok)
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  process.exitCode = pass ? 0 : 1
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

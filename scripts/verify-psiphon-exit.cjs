// 验证 Psiphon 出口的真实出口 IP，以及 psiphon.exe 进程的生命周期
const http = require('http')
const { execSync } = require('child_process')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const psiphonPids = () => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq psiphon.exe" /FO CSV /NH', { encoding: 'utf8' })
    return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes('psiphon.exe')).map((l) => l.split(',')[1].replace(/"/g, ''))
  } catch { return [] }
}

function getJson(path) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:9343${path}`, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => res(JSON.parse(b)))
    }).on('error', rej)
  })
}

;(async () => {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page')
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  const before = psiphonPids()
  console.log(`[0] 断开状态下 psiphon.exe 进程: ${before.length} 个`)

  await ev(`(() => {
    const row = [...document.querySelectorAll('.field-row')].find(r => r.querySelector('.t')?.textContent.includes('Psiphon'))
    const sw = row?.querySelector('.switch')
    if (sw && !sw.classList.contains('on')) sw.click()
    return !!sw
  })()`)
  await sleep(400)
  await ev(`document.querySelector('.connect-ring').click()`)

  let connected = false
  for (let i = 0; i < 75; i++) {
    await sleep(2000)
    connected = await ev(`!!document.querySelector('.connect-ring')?.classList.contains('connected')`)
    if (connected) break
  }
  if (!connected) {
    console.log('RESULT: FAIL（未连上）')
    ws.close(); process.exitCode = 1; return
  }

  const info = await ev(`(() => {
    const stats = [...document.querySelectorAll('.card')].map(c => ({
      label: c.querySelector('.muted')?.textContent || '',
      value: c.querySelector('.strong.mono')?.innerText || '',
      sub: c.querySelector('.muted:last-child')?.textContent || '',
    })).filter(s => s.label)
    const txt = document.body.innerText
    return {
      stats,
      session: (txt.match(/会话时长[^\\n]*/) || [''])[0],
      psiphonTag: txt.includes('Psiphon · 出口'),
    }
  })()`)

  const during = psiphonPids()
  console.log(`[1] 连接后 psiphon.exe 进程: ${during.length} 个 (pid ${during.join(',')})`)
  console.log(`[2] 会话标签含 "Psiphon · 出口" = ${info.psiphonTag}`)
  info.stats.slice(0, 4).forEach((s) => console.log(`    ${s.label.replace(/\n/g, ' ')} => ${s.value.replace(/\n/g, ' ')}`))

  // 断开
  await ev(`document.querySelector('.connect-ring').click()`)
  await sleep(4000)
  const after = psiphonPids()
  const still = await ev(`!!document.querySelector('.connect-ring')?.classList.contains('connected')`)
  console.log(`[3] 断开后 psiphon.exe 进程: ${after.length} 个；页面 connected=${still}`)

  const pass = before.length === 0 && during.length >= 1 && after.length === 0 && info.psiphonTag && !still
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  ws.close()
  process.exitCode = pass ? 0 : 1
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

// 真机闭环验收：WARP 直连 → 开 Psiphon → 断开 → 关 Psiphon → 反复直连
//
// 用户报障：开机第一次开 Psiphon 连接成功；断开并关闭 Psiphon 后再连一直失败。
// 1.7.7 曾把根因误判成「网络阻断 WARP UDP」，1.7.8 修正为 DNS 自举死锁 + 子进程代理变量污染。
// 版本断言从 package.json 读取，bump 后无需改脚本。
// 本脚本用 __TAURI_INTERNALS__.invoke 直接驱动 Rust core_connect，完整复现报障序列，
// 断言「关掉 Psiphon 后 WARP 直连仍可成功」。
//
// 连接方式：单步短 CDP 会话。core_connect 可能耗时数十秒，若在 Runtime.evaluate 里
// awaitPromise 会长期占用 WebSocket 被 WebView2 回收，因此改成页面内异步启动 → 结果写入
// window.__v178 → 脚本轮询读取（每个会话都很短）。
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 端点必须用当前网络可达的那个：本机 162.159.192.1 被网络层吞掉，
// 同一凭证对 .7 可正常建隧道（1.7.1 实际保存的端点也是 .7）。
const ENDPOINT = process.env.ENDPOINT_HOST || '162.159.192.7'
const ENDPOINT_PORT = Number(process.env.ENDPOINT_PORT || 2408)

function getJson(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}

async function ev(expr, timeoutMs = 15000) {
  const list = await getJson('/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws open timeout')), 8000)
    ws.addEventListener('open', () => { clearTimeout(t); res() })
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')) })
  })
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  })
  const send = (method, params, ms) => new Promise((res, rej) => {
    const id = ++seq
    const t = setTimeout(() => { pend.delete(id); rej(new Error(`${method} timeout`)) }, ms)
    pend.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  try {
    await send('Runtime.enable', {}, 8000)
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      throw new Error('JS: ' + String(d).split('\n')[0])
    }
    return r.result?.value
  } finally { try { ws.close() } catch {} }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

// 与 src/desktop.ts 的 coreConnect 参数一一对应（camelCase → Rust snake_case 由 Tauri 映射）
const startConnect = (key, psiphon) => ev(`(() => {
  const I = window.__TAURI_INTERNALS__.invoke
  window.__v178 = window.__v178 || {}
  window.__v178['${key}'] = { done: false }
  ;(async () => {
    try {
      const cred = await I('load_credential')
      const r = await I('core_connect', {
        cred, protocol: 'wg', port: 7890, apiPort: 9090, mtu: 1280, timeoutSec: 25,
        allowLan: false, frontConfig: null,
        dnsMode: 'preset', dnsCustom: '', dnsGuard: true, ipFamily: 'v4',
        subExit: 'warp', subViaWarp: false,
        endpointHost: '${ENDPOINT}', endpointPort: ${ENDPOINT_PORT},
        psiphon: ${psiphon ? 'true' : 'false'}, psiphonRegion: ''
      })
      // 注意：core_connect 失败时同样 resolve（CoreResult.error 非空），不能以「未抛异常」判成功
      window.__v178['${key}'] = {
        done: true,
        ok: !!r.ok,
        exitIp: r.exitIp || '',
        country: r.country || '',
        city: r.city || '',
        colo: r.colo || '',
        latency: r.latency || 0,
        fallback: !!r.fallback,
        fallbackReason: r.fallbackReason || '',
        credentialSource: r.credentialSource || '',
        endpointHost: r.endpointHost || '',
        endpointPort: r.endpointPort || 0,
        err: r.error || ''
      }
    } catch (e) {
      window.__v178['${key}'] = { done: true, ok: false, err: String((e && e.message) || e) }
    }
  })()
  return 'started'
})()`)

const readResult = (key) => ev(`window.__v178 && window.__v178['${key}']`)
const waitResult = async (key, maxSec = 180) => {
  for (let i = 0; i < maxSec / 3; i++) {
    await sleep(3000)
    let r
    try { r = await readResult(key) } catch (e) { continue }
    if (r && r.done) return r
    if (i % 5 === 4) console.log(`    ${key} 等待中 ${(i + 1) * 3}s …`)
  }
  return { done: false, ok: false, err: '等待超时' }
}

const stop = () => ev(`(async () => {
  try { await window.__TAURI_INTERNALS__.invoke('core_stop') } catch (e) {}
  return 1
})()`, 30000)

const step = async (key, label, psiphon) => {
  await startConnect(key, psiphon)
  const r = await waitResult(key)
  // 成功判定必须同时满足：Rust 侧 ok=true 且真的拿到了出口 IP
  const ok = !!(r && r.ok && r.exitIp)
  check(label, ok, ok
    ? `ip=${r.exitIp} country=${r.country} colo=${r.colo} ${r.latency}ms cred=${r.credentialSource} fallback=${r.fallback}${r.fallbackReason ? ' 原因=' + String(r.fallbackReason).slice(0, 90) : ''}`
    : `ok=${r && r.ok} ip=${(r && r.exitIp) || '<空>'} err=${String(r && r.err).slice(0, 260)}`)
  return r
}

;(async () => {
  const want = 'v' + JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  const ver = await ev(`(document.body.innerText.match(/v\\d+\\.\\d+\\.\\d+/) || [''])[0]`)
  check(`应用为 ${want}`, ver === want, `读到 ${ver || '<空>'}`)
  console.log(`端点：${ENDPOINT}:${ENDPOINT_PORT}`)

  // 先确保干净起点
  await stop()
  await sleep(1200)

  console.log('\n--- STEP0：未开启 Psiphon，WARP 直连（基线）---')
  const r0 = await step('s0', 'STEP0 WARP 直连成功', false)
  await stop(); await sleep(1500)

  console.log('\n--- STEP1：开启 Psiphon 出口连接（复现报障第一步）---')
  const r1 = await step('s1', 'STEP1 Psiphon 出口连接成功', true)
  await stop(); await sleep(1500)

  console.log('\n--- STEP2：断开并关闭 Psiphon 后再次 WARP 直连（用户报障点）---')
  const r2 = await step('s2', 'STEP2 关 Psiphon 后 WARP 直连成功【核心断言】', false)
  await stop(); await sleep(1500)

  console.log('\n--- STEP3：再连一次 WARP 直连（稳定性）---')
  const r3 = await step('s3', 'STEP3 连续直连仍成功', false)
  await stop(); await sleep(800)

  // 运行时配置检查：DNS 解析器必须直连，且不能再出现 1.7.7 的误导诊断
  console.log('\n--- 运行时配置检查 ---')
  let cfg = ''
  const cfgPath = path.join(process.env.APPDATA || '', 'com.antun.client', 'config.yaml')
  try { cfg = fs.readFileSync(cfgPath, 'utf8') } catch (e) { /* 下面统一判失败 */ }
  check('config.yaml 可读', !!cfg, cfgPath)
  if (cfg) {
    check('DNS 解析器 1.1.1.1/32 不再强制 DIRECT（跟随隧道，同 1.7.1）',
      !cfg.includes('1.1.1.1/32,DIRECT'))
    check('DNS 解析器 8.8.8.8/32 不再强制 DIRECT',
      !cfg.includes('8.8.8.8/32,DIRECT'))
    check('最后一次连接配置无 PSIPHON 出站（Psiphon 已关闭）', !cfg.includes('name: PSIPHON'))
    check(`最后配置端点落在 ${ENDPOINT}`, cfg.includes(`server: ${ENDPOINT}`))
  }

  const allErrs = [r0, r1, r2, r3].filter(Boolean).map((r) => r.err || r.fallbackReason || '').join(' | ')
  check('错误信息不含 1.7.7 的误导诊断（UDP 被阻断 / 建议开 Psiphon）',
    !allErrs.includes('UDP 出站') && !allErrs.includes('多半是网络阻断'), allErrs.slice(0, 200))

  console.log('\n==== 汇总 ====')
  const fail = results.filter((x) => !x.ok)
  console.log(`${results.length - fail.length}/${results.length} 通过`)
  if (fail.length) console.log('失败项: ' + fail.map((f) => f.name).join('; '))
  process.exit(fail.length ? 1 : 0)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })

/**
 * 节点延迟测试耗时对比（同一台机、同一份 76 节点订阅）：
 * 用法 node scripts/bench-node-delay.cjs 933x [label]
 * 只点「仅测延迟」，不跑下载测速，结束自动停核心。
 */
const http = require('http')
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = process.argv[2] || '9336'
const LABEL = process.argv[3] || 'build'

;(async () => {
  const page = (await getJson(`http://127.0.0.1:${PORT}/json`)).find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  let seq = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq
    pend.set(id, (m) => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error')
    return r.result?.value
  }
  await send('Runtime.enable', {})
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/确定|OK/.test(x.textContent||''));if(b)b.click();return 1})()`)
  await sleep(800)

  // 切到「模式」页
  await ev(`(()=>{const b=Array.from(document.querySelectorAll('.nav-item')).find(x=>/模式/.test(x.textContent||''));if(b)b.click();return 1})()`)
  await sleep(1200)

  const nodes = await ev(`document.querySelectorAll('.node-row.t').length`)
  console.log(`[${LABEL}] 节点数 = ${nodes}`)

  const clicked = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/仅测延迟/.test(x.textContent||''));if(!b)return 'missing';b.click();return 'ok'})()`)
  if (clicked !== 'ok') throw new Error('找不到「仅测延迟」按钮')

  const t0 = Date.now()
  let txt = ''
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    txt = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/测速中|仅测延迟/.test(x.textContent||''));return b?b.textContent.trim():''})()`)
    if (!/测速中/.test(txt)) break
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const stats = JSON.parse(await ev(`(()=>{
    const rows=Array.from(document.querySelectorAll('.node-row.t'));
    const delays=rows.map(r=>r.querySelector('.node-stat')?.textContent.trim()||'');
    const ok=delays.filter(t=>/^\\d+ ms$/.test(t));
    const nums=ok.map(t=>parseInt(t));
    const bad=delays.filter(t=>t==='—').length;
    const idle=delays.filter(t=>/\\. \\. \\./.test(t)).length;
    nums.sort((a,b)=>a-b);
    return JSON.stringify({ok:ok.length,bad,idle,min:nums[0]||0,median:nums[Math.floor(nums.length/2)]||0,max:nums[nums.length-1]||0})
  })()`))
  console.log(`[${LABEL}] 耗时 ${elapsed}s | 成功 ${stats.ok} 失败 ${stats.bad} 未测 ${stats.idle} | 延迟 min/中位/max = ${stats.min}/${stats.median}/${stats.max} ms`)
  await ev(`window.AnTunDesktop?.nodeTestStop?.()`).catch(() => {})
  ws.close()
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })

/**
 * 1.6.7 首页验收（真实连接，不做桩）：
 * 1) 「已选节点」在连接区左列（连接圆环下方），下拉有候选端点
 * 2) 实时速率卡片出现波形图（rate chart svg + 两条折线）
 * 3) 连接后写入「端点 → 机房」记录，首页可见并可点选
 * 结束时断开连接、还原系统代理。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const out = []
const log = (s) => { out.push(s); console.log(s) }
const fail = (s) => { out.push('FAIL: ' + s); console.log('FAIL: ' + s); process.exitCode = 1 }

const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROXY = 'http://127.0.0.1:7890'

function pump(bytes = 3_000_000) {
  const url = `https://speed.cloudflare.com/__down?bytes=${bytes}`
  try {
    return execFileSync('curl', ['-x', PROXY, '-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download}B %{speed_download}B/s', '--max-time', '20', url], { encoding: 'utf8', timeout: 25000 }).trim()
  } catch (e) {
    return 'curl-failed: ' + String(e.message).split('\n')[0]
  }
}

;(async () => {
  const list = await getJson('http://127.0.0.1:9333/json')
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到页面目标')
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
  const state = () => ev(`(()=>{const r=document.querySelector('.connect-ring');const t=r?r.innerText.replace(/\\n/g,'|'):'';
    if(/已连接/.test(t))return 'connected';if(/正在连接/.test(t))return 'connecting';return 'idle'})()`)
  await send('Runtime.enable', {})
  await send('Page.enable', {})

  const dismissed = await ev(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(x=>/确定|OK|知道了/.test(x.textContent||''));if(b){b.click();return 1}return 0})()`)
  log(`[0] 公告弹窗 ${dismissed ? '已关闭' : '不存在'}`)
  await sleep(2500)

  // 1) 布局
  const box = JSON.parse(await ev(`(()=>{
    const side=document.querySelector('.home-connect-side');
    const ring=document.querySelector('.connect-ring');
    const pick=document.querySelector('.home-node-pick');
    if(!ring||!pick||!side) return JSON.stringify({miss:true});
    const r=ring.getBoundingClientRect(),p=pick.getBoundingClientRect();
    const cs=getComputedStyle(side);
    return JSON.stringify({dir:cs.flexDirection,inSide:side.contains(pick),ring:[r.x,r.y,r.width,r.right,r.bottom],pick:[p.x,p.y,p.width,p.right,p.bottom]})
  })()`))
  if (box.miss) fail('找不到连接区 / 圆环 / 已选节点块')
  else {
    const below = box.pick[1] > box.ring[4] - 6
    const beside = box.pick[0] > box.ring[3] - 6
    log(`[1] 连接区 flex=${box.dir} 已选节点在左列=${box.inSide} 圆环=(${box.ring[0].toFixed(0)},${box.ring[1].toFixed(0)}) 节点块=(${box.pick[0].toFixed(0)},${box.pick[1].toFixed(0)}) 宽${box.pick[2].toFixed(0)} → ${box.inSide && (below || beside) ? '位置正确 ✓' : '位置异常 ✗'}`)
    if (!box.inSide || !(below || beside)) fail('已选节点不在连接区')
  }
  const optCount = await ev(`document.querySelectorAll('.home-node-pick select option').length`)
  log(`[1] 节点下拉选项数 = ${optCount}`)
  if (!(optCount > 1)) fail('节点下拉没有候选')
  const nodeVal = await ev(`document.querySelector('.home-node-pick select')?.value`)
  log(`[1] 当前选择 = ${nodeVal}`)

  const before = await ev(`document.querySelectorAll('svg[aria-label^="rate chart"]').length`)
  log(`[2] 进入首页时状态=${await state()} 波形图数量=${before}`)

  // 3) 连接（若上来就是已连接，先断开再走一次完整连接流程）
  if ((await state()) === 'connected') { await ev(`document.querySelector('.connect-ring').click()`); await sleep(4000) }
  await ev(`(()=>{document.querySelector('.connect-ring').click();return 1})()`)
  let st = ''
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    st = await state()
    if (st !== 'connecting') { log(`[3] ${(i + 1) * 2}s 后状态 = ${st}`); break }
  }
  if (st !== 'connected') {
    fail(`连接未成功（${st}）`)
    await ev(`(()=>{const b=Array.from(document.querySelectorAll('.nav-item')).find(x=>/日志/.test(x.textContent||''));if(b)b.click();return 1})()`)
    await sleep(1200)
    log('日志尾部:\n' + await ev(`(()=>document.querySelector('.content-scroll')?.innerText.split('\\n').slice(-14).join('\\n'))()`))
  } else {
    const cfg = path.join(process.env.APPDATA, 'com.antun.client', 'config.yaml')
    const lines = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8').split('\n') : []
    log(`[3] config 端点 = ${(lines.find((l) => /^\s+- server:/.test(l)) || '').trim().replace('- server: ', '')} | 含订阅前置 = ${/SUB-NODE/.test(lines.join('\n'))}`)
    const info = await ev(`(()=>{const ls=document.body.innerText.split('\\n');const i=ls.findIndex(l=>l.indexOf('国家 / 机房')>=0);return i<0?'':ls.slice(i,i+3).join(' ').slice(0,80)})()`)
    log(`[3] 出口信息: ${info}`)

    // 4) 灌流量
    for (let i = 0; i < 4; i++) {
      log(`[4] 下载样本 ${i + 1}: ${pump(3_000_000)}`)
      await sleep(1600)
    }
    await sleep(1500)

    // 5) 波形
    const chart = JSON.parse(await ev(`(()=>{
      const svg=document.querySelector('svg[aria-label^="rate chart"]');
      const pts=svg?Array.from(svg.querySelectorAll('polyline')).map(p=>p.getAttribute('points').split(' ').length):[];
      const card=Array.from(document.querySelectorAll('.card')).find(c=>/实时速率/.test(c.innerText));
      return JSON.stringify({svg:!!svg,series:pts,nums:(card?card.innerText:'').replace(/\\n/g,' | ').slice(0,150)})
    })()`))
    log(`[5] 波形图=${chart.svg} 折线=${chart.series.join('/') || '-'}`)
    log(`[5] 卡片: ${chart.nums}`)
    if (!chart.svg) fail('速率波形图没有渲染')
    if (chart.series.some((n) => n < 2)) fail('波形折线点数不足')

    // 6) 机房记录
    const rec = JSON.parse(await ev(`(()=>{
      const raw=JSON.parse(localStorage.getItem('antun-prefs')||'{}');
      const coloLog=raw.state?.coloLog||raw.coloLog||{};
      return JSON.stringify(Object.values(coloLog).map(r=>r.host+':'+r.port+' -> '+r.country+'/'+r.colo+' hits='+r.hits))
    })()`))
    log(`[6] coloLog = ${JSON.stringify(rec)}`)
    if (!rec.length) fail('没有写入端点→机房记录')
    const uiRec = await ev(`(()=>{const t=document.body.innerText;return /本机实测：端点 → 机房/.test(t)?'ok':'missing'})()`)
    log(`[6] 首页机房记录区 = ${uiRec}`)

    // 7) 截图
    await ev(`(()=>{const el=document.querySelector('.content-scroll');if(el)el.scrollTop=el.scrollHeight;return 1})()`)
    await sleep(800)
    fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-167-speed.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    await ev(`(()=>{const el=document.querySelector('.content-scroll');if(el)el.scrollTop=0;return 1})()`)
    await sleep(600)
    fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-167-home.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

    // 7) 手动按机房换端点：点一条非当前记录，应锁定并用该端点重连
    const target = await ev(`(()=>{
      const row=Array.from(document.querySelectorAll('.colo-row')).find(r=>!r.classList.contains('selected')&&!r.classList.contains('disabled'));
      if(!row)return '';
      const txt=row.innerText.replace(/\\n/g,' ');
      row.click();
      return txt;
    })()`)
    if (!target) log('[7] 没有可点选的其他机房记录（跳过）')
    else {
      log(`[7] 点击记录: ${target}`)
      const host = target.split(' ')[0].split(':')[0]
      let ok = false
      for (let i = 0; i < 45; i++) {
        await sleep(2000)
        const s2 = await state()
        if (s2 === 'connected') {
          const cfg2 = fs.readFileSync(path.join(process.env.APPDATA, 'com.antun.client', 'config.yaml'), 'utf8')
          const srv2 = (cfg2.split('\n').find((l) => /^\s+- server:/.test(l)) || '').trim().replace('- server: ', '')
          if (srv2 === host) { log(`[7] 重连完成，${(i + 1) * 2}s 后 config 端点 = ${srv2}（与点击行一致 ✓）`); ok = true; break }
        }
      }
      if (!ok) fail('点击机房记录后没有按该端点重连')
    }

    // 8) 断开并清理
    await ev(`(()=>{document.querySelector('.connect-ring').click();return 1})()`)
    await sleep(4000)
    await ev(`window.AnTunDesktop.coreStop()`)
    log('[8] 已断开并停止核心')
  }

  fs.writeFileSync(path.join(__dirname, '..', 'verify-home-1_6_7.log'), out.join('\n') + '\n')
  ws.close()
  log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
})().catch((e) => {
  fail(e.message)
  console.log('RESULT: FAIL')
}).finally(async () => {
  // 无论成败都断开，避免把测试机的系统代理指向已死端口
  try {
    const list = await getJson('http://127.0.0.1:9333/json')
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
    let id = 0
    const send = (method, params) => new Promise((res) => {
      const i = ++id
      const h = (evt) => {
        const m = JSON.parse(evt.data)
        if (m.id === i) { ws.removeEventListener('message', h); res(m) }
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
    await send('Runtime.evaluate', { expression: `(()=>{const r=document.querySelector('.connect-ring');if(r&&/已连接/.test(r.innerText))r.click();return 1})()`, awaitPromise: true })
    await new Promise((r) => setTimeout(r, 4000))
    await send('Runtime.evaluate', { expression: 'window.AnTunDesktop.coreStop()', awaitPromise: true })
    console.log('cleanup: core stopped')
    ws.close()
  } catch { console.log('cleanup: 失败，请手动断开') }
})

/**
 * 1.7.1 真机验收（接的是已安装的 AnTun，不是预览）
 * 1) 模式页：真实订阅节点前是否有国旗，港澳台是否用中国国旗
 * 2) 首页机房记录：国旗 + 「端点 → 机房」表头对齐
 * 3) 设置页：订阅节点直出时「协议」只读、外层协议已移除
 * 4) 真连一次：出口 IP / 国家机房前带国旗，会话标签与出口一致（连不上就跳过，不伪造）
 * 用法：AnTun.exe 带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9343 启动
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const out = []
const log = (s) => { out.push(s); console.log(s) }
const fail = (s) => { out.push('FAIL: ' + s); console.log('FAIL: ' + s); process.exitCode = 1 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})

;(async () => {
  const list = await getJson('http://127.0.0.1:9343/json')
  const page = list.filter((t) => t.type === 'page').find((t) => /tauri|localhost|index/.test(t.url)) || list.find((t) => t.type === 'page')
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
  await send('Runtime.enable', {})
  await send('Page.enable', {})

  const goto = async (label) => {
    const ok = await ev(`(()=>{
      const els=[...document.querySelectorAll('button,a,li,div[role="button"]')];
      const el=els.find(e=>e.innerText&&e.innerText.trim()===${JSON.stringify(label)}&&e.offsetParent);
      if(!el) return false; el.click(); return true
    })()`)
    if (!ok) throw new Error(`导航失败：${label}`)
    await sleep(800)
  }

  log(`页面 URL: ${page.url}`)
  const ver = await ev(`document.querySelector('.side-version, .version, footer')?.innerText || ''`)
  const pkgVer = await ev(`(()=>{try{return JSON.parse(localStorage.getItem('antun-prefs')).state.settings.lang}catch(e){return '?'}})()`)
  log(`语言设置=${pkgVer}`)

  // ===== [1] 模式页订阅节点国旗 =====
  await goto('模式')
  await sleep(600)
  // 国旗是 loading="lazy" 的，长列表里屏外的不会开始加载；
  // 测试时把它们强制改成即刻加载，否则会把「还没轮到加载」误判成「加载失败」
  await ev(`(()=>{document.querySelectorAll('img.flag').forEach(i=>{i.loading='eager';const s=i.getAttribute('src');i.setAttribute('src','');i.setAttribute('src',s)});return 1})()`)
  await sleep(1500)
  const nodes = JSON.parse(await ev(`(()=>{
    const rs=[...document.querySelectorAll('.node-row')].filter(r=>r.querySelector('.cell.mono'));
    return JSON.stringify(rs.map(r=>{
      const img=r.querySelector('img.flag'); const globe=r.querySelector('svg.flag-none');
      return { name: r.children[0]?.innerText, src: img? img.getAttribute('src'):'', loaded: img? (img.complete&&img.naturalWidth>0):false, globe: !!globe }
    }))
  })()`))
  log(`[1] 真实订阅节点 ${nodes.length} 行`)
  const withFlag = nodes.filter((n) => n.src)
  const globes = nodes.filter((n) => !n.src && n.globe)
  log(`[1] 有国旗 ${withFlag.length} 个，地球图标 ${globes.length} 个`)
  nodes.slice(0, 12).forEach((n) => log(`      ${n.name}  → ${n.src || (n.globe ? '地球' : '无')}`))
  if (!nodes.length) fail('模式页没有读到订阅节点')
  const brokenImgs = withFlag.filter((n) => !n.loaded)
  if (brokenImgs.length) fail(`${brokenImgs.length} 个国旗没加载出来：${brokenImgs.map((b) => b.src).join(',')}`)
  if (!nodes.some((n) => n.src || n.globe)) fail('节点行前面没有任何图标')
  const twNode = nodes.find((n) => /台湾|台灣|\.tw\b|icook\.tw|\.com\.tw/i.test(n.name || ''))
  if (twNode && twNode.src !== '/flags/cn.svg') fail(`台湾相关节点「${twNode.name}」用了 ${twNode.src}（应为 cn.svg）`)
  else if (twNode) log(`[1] 台湾相关节点「${twNode.name}」→ cn.svg ✅`)

  await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-171-modes.png', Buffer.from(r.data, 'base64')))

  // ===== [2] 首页机房记录 =====
  await goto('首页')
  await sleep(500)
  const colo = JSON.parse(await ev(`(()=>{
    const rows=[...document.querySelectorAll('.colo-row')];
    const head=document.querySelector('.colo-head');
    const label=head? head.querySelector('span'):null;
    const first=rows[0]? rows[0].children[0]:null;
    return JSON.stringify({
      headText: label? label.innerText : '',
      align: (label&&first)? Math.abs(label.getBoundingClientRect().left-first.getBoundingClientRect().left) : -1,
      rows: rows.map(r=>{
        const img=r.querySelector('img.flag');
        return { host: r.children[0]?.innerText, src: img? img.getAttribute('src'):'', loaded: img?(img.complete&&img.naturalWidth>0):false, text: r.children[2]?.innerText.replace(/\\n/g,' ') }
      }),
    })
  })()`))
  log(`[2] 表头="${colo.headText}" 与首列偏差=${colo.align === -1 ? 'n/a' : colo.align.toFixed(1) + 'px'}`)
  colo.rows.forEach((r) => log(`      ${r.host}  ${r.src || '(无旗)'} loaded=${r.loaded}  "${r.text}"`))
  if (colo.headText && /本机实测/.test(colo.headText)) fail('表头仍带「本机实测：」')
  if (colo.align > 1.5) fail(`表头与首列差 ${colo.align.toFixed(1)}px`)
  if (colo.rows.length) {
    const bad = colo.rows.filter((r) => !r.src || !r.loaded)
    if (bad.length) fail(`${bad.length} 条机房记录缺国旗或未加载`)
  } else {
    log('      （本机还没有机房观测记录，跳过行内国旗断言）')
  }

  // ===== [3] 设置页协议 =====
  await goto('设置')
  await sleep(500)
  const proto = JSON.parse(await ev(`(()=>{
    const rows=[...document.querySelectorAll('.field-row')];
    const titles=rows.map(x=>x.querySelector('.field-label .t')?.innerText||'');
    const r=rows.find(x=>/^协议/.test((x.querySelector('.field-label .t')?.innerText||'').trim()));
    return JSON.stringify({
      titles,
      title: r? r.querySelector('.field-label .t').innerText : '',
      seg: r? r.querySelectorAll('.segment button').length : -1,
      ro: r? (r.querySelector('.proto-readonly')?.innerText.replace(/\\n/g,' ')||'') : '',
      desc: r? (r.querySelector('.field-label .d')?.innerText||'') : '',
    })
  })()`))
  log(`[3] 协议项标题="${proto.title}" 可点按钮=${proto.seg} 只读块="${proto.ro}"`)
  if (proto.titles.some((x) => x.includes('外层协议'))) fail('外层协议项还在')
  const mode = await ev(`(()=>{try{const s=JSON.parse(localStorage.getItem('antun-prefs')).state.settings;return JSON.stringify({connMode:s.connMode,subExit:s.subExit,subViaWarp:s.subViaWarp})}catch(e){return '{}'}})()`)
  log(`[3] 当前模式=${mode}`)
  const m = JSON.parse(mode || '{}')
  const nodeDirect = m.connMode === 'subscription' && m.subExit === 'node' && !m.subViaWarp
  if (nodeDirect) {
    if (proto.seg !== 0) fail('订阅节点直出时协议仍可点选')
    if (!/节点出口/.test(proto.ro)) fail('只读块缺少「节点出口」标记')
  } else {
    if (proto.seg < 6) fail('当前 WARP 参与建链，协议应可点选 6 项')
  }
  await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-171-settings.png', Buffer.from(r.data, 'base64')))

  // ===== [4] 真连一次：出口 IP / 国家机房前的国旗 =====
  await goto('首页')
  await sleep(400)
  const already = await ev(`document.querySelector('.connect-ring.connected') ? true : false`)
  if (already) log('[4] 已经是连接状态，直接读取')
  else {
    log('[4] 点击连接圆环，最多等 45 秒…')
    await ev(`(()=>{document.querySelector('.connect-ring').click();return 1})()`)
    for (let i = 0; i < 45; i++) {
      await sleep(1000)
      if (await ev(`document.querySelector('.connect-ring.connected') ? true : false`)) break
    }
  }
  const st = JSON.parse(await ev(`(()=>{
    const stats=[...document.querySelectorAll('.card')].filter(c=>c.querySelector('.muted'));
    const cells=[...document.querySelectorAll('.grid-3 .card')];
    const pick=(i)=>{
      const c=cells[i]; if(!c) return {label:'',value:'',flag:'',loaded:false};
      const img=c.querySelector('img.flag');
      return {
        label: c.querySelector('.muted')?.innerText||'',
        value: c.querySelector('.strong')?.innerText||'',
        flag: img? img.getAttribute('src'):'',
        loaded: img? (img.complete&&img.naturalWidth>0):false,
      }
    };
    return JSON.stringify({ connected: !!document.querySelector('.connect-ring.connected'), ip: pick(0), region: pick(1) })
  })()`))
  log(`[4] 已连接=${st.connected}`)
  log(`[4] 出口IP 卡片: 值="${st.ip.value}" 国旗=${st.ip.flag || '(无)'} loaded=${st.ip.loaded}`)
  log(`[4] 国家/机房 卡片: 值="${st.region.value}" 国旗=${st.region.flag || '(无)'} loaded=${st.region.loaded}`)
  if (st.connected) {
    if (!st.ip.value || st.ip.value === '—') fail('连接后出口 IP 仍为空')
    if (!st.ip.flag) fail('出口 IP 前没有国旗')
    else if (!st.ip.loaded) fail(`出口 IP 国旗没加载（${st.ip.flag}）`)
    if (!st.region.flag) fail('国家/机房前没有国旗')
    if (/TW|HK|MO/.test(st.region.value) && !/中国/.test(st.region.value)) fail('港澳台地区没有显示「中国X」')
    await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-171-connected.png', Buffer.from(r.data, 'base64')))
    // 断开，把系统代理还原
    await ev(`(()=>{document.querySelector('.connect-ring').click();return 1})()`)
    await sleep(2500)
    const off = await ev(`!document.querySelector('.connect-ring.connected')`)
    log(`[4] 已断开并还原代理=${off}`)
  } else {
    log('[4] 未连上，跳过出口卡片断言（不在界面伪造数据）')
  }

  fs.writeFileSync(path.join(__dirname, '..', 'verify-tauri-1_7_1.log'), out.join('\n') + '\n')
  ws.close()
  log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
})().catch((e) => {
  fail(e.message)
  console.log('RESULT: FAIL')
})

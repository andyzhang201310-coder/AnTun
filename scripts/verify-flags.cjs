/**
 * 国旗图标 + 机房表头对齐 + 设置页协议项 验收（纯前端，不建隧道）
 * 1) 首页出口机房记录：每行有 <img class="flag">，港澳台用中国国旗 + 「中国X」文案
 * 2) 机房表头去掉「本机实测：」，且左边缘与记录行第一列对齐
 * 3) 模式页订阅节点：按名称/域名推断国旗，判不出来的显示地球图标
 * 4) 设置页：订阅节点直出时「协议」降级为只读，「外层协议」已移除
 * 用法：vite preview 起 4173，无头 Chrome 带 --remote-debugging-port=9341
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

const now = Date.now()
const colo = (host, country, c, city, ago) => ({
  id: `${host}:0`, host, port: 2408, country, colo: c, city, hits: 2, ts: now - ago,
})

const NODES = [
  ['n1', '🇯🇵 东京 01', '103.1.1.1'],
  ['n2', '台湾 中华电信', '103.1.1.2'],
  ['n3', '香港 HKT 01', '103.1.1.3'],
  ['n4', '优选域名 www.visa.co.jp #1', 'www.visa.co.jp'],
  ['n5', '官方优选IP 104.16.192.1 #15', '104.16.192.1'],
  ['n6', '新加坡 SG-01', '103.1.1.6'],
].map(([id, name, server]) => ({ id, subId: 's1', name, nodeType: 'vless', server, port: 443, config: `  - name: "N-${id}"\n    type: vless\n    server: ${server}\n    port: 443\n` }))

const PREFS = {
  settings: { connMode: 'subscription', subExit: 'node', subViaWarp: false, frontNodeId: 'n2', proto: 'gool', lang: 'zh', theme: 'light', subSort: 'default' },
  subNodes: NODES,
  coloLog: {
    '162.159.192.1:2408': colo('162.159.192.1', 'TW', 'TPE', 'Taipei', 60000),
    '162.159.195.7:2408': colo('162.159.195.7', 'HK', 'HKG', 'Hong Kong', 120000),
    '188.114.96.7:2408': colo('188.114.96.7', 'JP', 'NRT', 'Tokyo', 180000),
    '188.114.99.7:2408': colo('188.114.99.7', 'US', 'LAX', 'Los Angeles', 240000),
  },
}

;(async () => {
  const list = await getJson('http://127.0.0.1:9341/json')
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
  await send('Runtime.enable', {})
  await send('Page.enable', {})
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false })

  const goto = async (label) => {
    const ok = await ev(`(()=>{
      const els=[...document.querySelectorAll('button,a,li,div[role="button"]')];
      const el=els.find(e=>e.innerText&&e.innerText.trim()===${JSON.stringify(label)}&&e.offsetParent);
      if(!el) return false; el.click(); return true
    })()`)
    if (!ok) throw new Error(`导航失败：${label}`)
    await sleep(700)
  }
  const load = async (prefs) => {
    await send('Page.navigate', { url: 'http://localhost:4173/' })
    await sleep(900)
    await ev(`localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify({ state: prefs, version: 0 }))});localStorage.setItem('antun-notice-seen','1');1`)
    await send('Page.reload')
    await sleep(2200)
  }

  await load(PREFS)

  // ===== [1] 首页机房记录：国旗 =====
  const rows = JSON.parse(await ev(`(()=>{
    const rs=[...document.querySelectorAll('.colo-row')];
    return JSON.stringify(rs.map(r=>{
      const img=r.querySelector('img.flag');
      return {
        host: r.querySelector('.cell')?.innerText,
        flagSrc: img? img.getAttribute('src') : '',
        flagLoaded: img? (img.complete && img.naturalWidth>0) : false,
        text: r.children[2]?.innerText.replace(/\\n/g,' '),
      }
    }))
  })()`))
  log(`[1] 机房记录 ${rows.length} 行：`)
  rows.forEach((r) => log(`      ${r.host}  flag=${r.flagSrc || '(无)'} loaded=${r.flagLoaded}  "${r.text}"`))
  if (!rows.length) fail('机房记录没有渲染')
  for (const r of rows) {
    if (!r.flagSrc) fail(`${r.host} 缺少国旗`)
    else if (!r.flagLoaded) fail(`${r.host} 国旗没有真正加载（${r.flagSrc}）`)
  }
  const tw = rows.find((r) => /中国台湾/.test(r.text || ''))
  if (!tw) fail('台湾记录没有显示「中国台湾」')
  else {
    if (tw.flagSrc !== '/flags/cn.svg') fail(`台湾记录用了错误的国旗 ${tw.flagSrc}（应为 /flags/cn.svg）`)
    if (/TW/.test(tw.text)) fail('台湾记录仍在显示 TW 代码')
  }
  if (!rows.some((r) => /中国香港/.test(r.text || '') && r.flagSrc === '/flags/cn.svg')) fail('香港记录没有用中国国旗 + 中国香港')

  // ===== [2] 表头文案与对齐 =====
  const head = JSON.parse(await ev(`(()=>{
    const h=document.querySelector('.colo-head');
    if(!h) return JSON.stringify({miss:true});
    const label=h.querySelector('span');
    const row=document.querySelector('.colo-row');
    const firstCell=row? row.children[0] : null;
    const lb=label.getBoundingClientRect(), cb=firstCell? firstCell.getBoundingClientRect() : null;
    return JSON.stringify({
      text: label.innerText, hasMeasured: /本机实测/.test(label.innerText),
      labelLeft: lb.left, cellLeft: cb? cb.left : -1,
      rowPadLeft: row? getComputedStyle(row).paddingLeft : '',
    })
  })()`))
  log(`[2] 表头="${head.text}" 含「本机实测」=${head.hasMeasured} labelLeft=${(head.labelLeft||0).toFixed(1)} 首列cellLeft=${(head.cellLeft||0).toFixed(1)} 行paddingLeft=${head.rowPadLeft}`)
  if (head.miss) fail('找不到 .colo-head')
  if (head.hasMeasured) fail('表头仍带「本机实测：」前缀')
  if (!/端点\s*→\s*机房/.test(head.text)) fail('表头不是「端点 → 机房」')
  if (Math.abs((head.labelLeft || 0) - (head.cellLeft || 0)) > 1.5) fail(`表头与首列没有对齐（差 ${((head.labelLeft||0)-(head.cellLeft||0)).toFixed(1)}px）`)

  await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-flags-home.png', Buffer.from(r.data, 'base64')))

  // ===== [3] 模式页订阅节点国旗 =====
  await goto('模式')
  const nodeRows = JSON.parse(await ev(`(()=>{
    const rs=[...document.querySelectorAll('.node-row')];
    return JSON.stringify(rs.map(r=>{
      const img=r.querySelector('img.flag'); const globe=r.querySelector('svg.flag-none');
      return { name: r.children[0]?.innerText, src: img? img.getAttribute('src'):'', loaded: img? (img.complete&&img.naturalWidth>0):false, globe: !!globe }
    }))
  })()`))
  log(`[3] 订阅节点 ${nodeRows.length} 行：`)
  nodeRows.forEach((r) => log(`      ${r.name}  → ${r.src || (r.globe ? '地球图标' : '无图标')} ${r.src ? '(loaded=' + r.loaded + ')' : ''}`))
  const pick = (kw) => nodeRows.find((r) => (r.name || '').includes(kw))
  const cases = [
    ['东京', '/flags/jp.svg'],
    ['台湾', '/flags/cn.svg'],
    ['香港', '/flags/cn.svg'],
    ['visa.co.jp', '/flags/jp.svg'],
    ['新加坡', '/flags/sg.svg'],
  ]
  for (const [kw, want] of cases) {
    const row = pick(kw)
    if (!row) { fail(`找不到节点「${kw}」`); continue }
    if (row.src !== want) fail(`节点「${kw}」国旗=${row.src || '(无)'}，应为 ${want}`)
    if (!row.loaded) fail(`节点「${kw}」国旗未加载`)
  }
  const ipNode = pick('官方优选IP')
  if (!ipNode) fail('找不到官方优选IP 节点')
  else if (ipNode.src) fail(`官方优选IP 不该有国旗（推断不出国家），实际=${ipNode.src}`)
  else if (!ipNode.globe) fail('官方优选IP 应显示地球图标占位')

  await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-flags-nodes.png', Buffer.from(r.data, 'base64')))

  // ===== [4] 设置页协议项 =====
  await goto('设置')
  const protoField = async () => JSON.parse(await ev(`(()=>{
    const rows=[...document.querySelectorAll('.field-row')];
    const r=rows.find(x=>{
      const t=x.querySelector('.field-label .t');
      return t && /^协议/.test(t.innerText.trim());
    });
    if(!r) return JSON.stringify({miss:true, titles: rows.map(x=>x.querySelector('.field-label .t')?.innerText)});
    const seg=r.querySelectorAll('.segment button').length;
    const ro=r.querySelector('.proto-readonly');
    return JSON.stringify({
      title: r.querySelector('.field-label .t').innerText,
      desc: r.querySelector('.field-label .d')?.innerText||'',
      segButtons: seg,
      readonly: ro? ro.innerText.replace(/\\n/g,' ') : '',
      hasLock: !!ro?.querySelector('svg'),
    })
  })()`))
  const pf = await protoField()
  log(`[4] 订阅节点直出：标题="${pf.title}" 分段按钮=${pf.segButtons} 只读块="${pf.readonly}"`)
  log(`[4] 说明="${pf.desc}"`)
  if (pf.miss) fail('设置页找不到「协议」项：' + JSON.stringify(pf.titles))
  if (pf.segButtons > 0) fail('订阅节点直出时协议仍可点选')
  if (!/VLESS/.test(pf.readonly || '')) fail('只读块没有显示节点自己的协议')
  if (!/节点出口/.test(pf.readonly || '')) fail('只读块缺少「节点出口」标记')
  const outerGone = await ev(`(()=>[...document.querySelectorAll('.field-label .t')].some(x=>x.innerText.includes('外层协议')))()`)
  log(`[4] 外层协议项还在吗 = ${outerGone}（应为 false）`)
  if (outerGone) fail('外层协议项没有移除')

  // 订阅网关模式：协议必须恢复可点
  const warpPrefs = JSON.parse(JSON.stringify(PREFS))
  warpPrefs.settings.connMode = 'warp'
  await load(warpPrefs)
  await goto('设置')
  const pf2 = await protoField()
  log(`[4] WARP 模式：标题="${pf2.title}" 分段按钮=${pf2.segButtons} 只读块="${pf2.readonly}"`)
  if (pf2.segButtons < 6) fail('WARP 模式下协议没有恢复成 6 个可选按钮')
  if (pf2.readonly) fail('WARP 模式下协议不该是只读')

  // 订阅节点出口 + 经 WARP 承载：协议也有效，必须可点
  const viaPrefs = JSON.parse(JSON.stringify(PREFS))
  viaPrefs.settings.subViaWarp = true
  await load(viaPrefs)
  await goto('设置')
  const pf3 = await protoField()
  log(`[4] 节点出口 + 经 WARP 承载：分段按钮=${pf3.segButtons}（应 6）`)
  if (pf3.segButtons < 6) fail('开启 WARP 承载后协议应恢复可选')

  fs.writeFileSync(path.join(__dirname, '..', 'verify-flags.log'), out.join('\n') + '\n')
  ws.close()
  log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
})().catch((e) => {
  fail(e.message)
  console.log('RESULT: FAIL')
})

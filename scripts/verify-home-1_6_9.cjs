/**
 * 1.6.9 首页文案与协议只读验收（纯前端，不建隧道）：
 * 1) 顶栏「主页」与「一键扫描最优端点并建立加密隧道」同一行，免责声明占原来的第二行
 * 2) 订阅模式 + 节点出口：协议下拉框只读，显示订阅节点自己的协议（VLESS），点不开菜单
 * 3) WARP 直连模式：协议下拉框恢复可点，菜单能展开
 * 用法：先 vite preview 起 4173，再跑本脚本（无头 Chrome 需 --remote-debugging-port=9334）
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

const PREFS = {
  settings: {
    connMode: 'subscription', subExit: 'node', subViaWarp: false,
    frontNodeId: 'n1', proto: 'gool', lang: 'zh', theme: 'dark', autoConnect: false,
  },
  subNodes: [{
    id: 'n1', subId: 's1', name: '官方优选IP 104.17.128.1 #1', nodeType: 'vless',
    server: '104.17.128.1', port: 443,
    config: '  - name: "SUB-NODE"\n    type: vless\n    server: 104.17.128.1\n    port: 443\n',
  }],
  coloLog: {
    '162.159.192.1:2408': { id: '162.159.192.1:2408', host: '162.159.192.1', port: 2408, country: 'US', colo: 'SJC', city: 'San Jose', hits: 3, ts: Date.now() },
  },
}

;(async () => {
  const list = await getJson('http://127.0.0.1:9334/json')
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

  const load = async (prefs) => {
    await send('Page.navigate', { url: 'http://localhost:4173/' })
    await sleep(900)
    await ev(`localStorage.setItem('antun-prefs', ${JSON.stringify(JSON.stringify({ state: prefs, version: 0 }))});localStorage.setItem('antun-notice-seen','1');1`)
    await send('Page.reload')
    await sleep(2200)
  }

  // ===== 订阅模式 + 节点出口 =====
  await load(PREFS)

  const head = JSON.parse(await ev(`(()=>{
    const title=document.querySelector('.section-title');
    const sub=document.querySelector('.section-sub-inline');
    const notice=document.querySelector('.section-notice');
    if(!title||!sub||!notice) return JSON.stringify({miss:true,title:!!title,sub:!!sub,notice:!!notice});
    const t=title.getBoundingClientRect(),s=sub.getBoundingClientRect(),n=notice.getBoundingClientRect();
    return JSON.stringify({
      title:title.innerText,sub:sub.innerText,notice:notice.innerText,
      sameLine: Math.abs((t.top+t.bottom)/2-(s.top+s.bottom)/2) < 8 && s.left > t.right - 4,
      noticeBelow: n.top > s.bottom - 2, titleRight: t.right, subLeft: s.left,
      oldSubGone: !document.querySelector('p.section-sub'),
    })
  })()`))
  log(`[1] 标题="${head.title}" 副标题="${head.sub}"`)
  log(`[1] 免责声明="${head.notice}"`)
  log(`[1] 同一行=${head.sameLine}（title.right=${(head.titleRight || 0).toFixed(0)} sub.left=${(head.subLeft || 0).toFixed(0)}） 声明在第二行=${head.noticeBelow} 旧副标题已移除=${head.oldSubGone}`)
  if (head.miss) fail('顶栏结构缺失')
  if (!head.sameLine) fail('副标题没有和「主页」同一行')
  if (!head.noticeBelow) fail('免责声明没有占原来副标题的位置')
  if (!/开源免费/.test(head.notice)) fail('第二行不是免责声明')

  const proto = JSON.parse(await ev(`(()=>{
    const box=document.querySelector('.proto-select');
    const btn=box?.querySelector('.proto-trigger');
    if(!box||!btn) return JSON.stringify({miss:true});
    return JSON.stringify({
      disabledClass: box.classList.contains('disabled'),
      btnDisabled: btn.disabled,
      value: box.querySelector('.proto-value')?.innerText,
      lock: box.querySelector('.proto-lock')?.innerText||'',
      label: box.querySelector('.proto-label')?.innerText,
      hint: box.querySelector('.proto-hint')?.innerText||'',
      cursor: getComputedStyle(btn).cursor,
    })
  })()`))
  log(`[2] 协议块：禁用=${proto.disabledClass}/${proto.btnDisabled} 显示值="${proto.value}" 标记="${proto.lock}" 标签="${proto.label}"`)
  log(`[2] 提示="${proto.hint}" cursor=${proto.cursor}`)
  if (proto.miss) fail('找不到协议下拉框')
  if (!proto.disabledClass || !proto.btnDisabled) fail('订阅节点出口模式下协议下拉框没有禁用')
  if (!/VLESS/i.test(proto.value || '')) fail('协议框没有显示订阅节点自己的协议')
  if (proto.value === 'GOOL') fail('协议框仍显示 GOOL')

  await ev(`(()=>{document.querySelector('.proto-trigger').click();return 1})()`)
  await sleep(300)
  const menuOpen = await ev(`document.querySelectorAll('.proto-menu').length`)
  log(`[2] 点击后菜单数量=${menuOpen}（应为 0）`)
  if (menuOpen) fail('只读状态下菜单仍能展开')

  const sessionLabel = await ev(`(()=>{const el=document.querySelector('.home-node-pick-active');return el?el.innerText.replace(/\\n/g,' '):''})()`)
  log(`[2] 已选节点行="${sessionLabel}"`)

  fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-169-sub.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

  // ===== WARP 直连：协议恢复可点 =====
  const warpPrefs = JSON.parse(JSON.stringify(PREFS))
  warpPrefs.settings.connMode = 'warp'
  await load(warpPrefs)
  const warpProto = JSON.parse(await ev(`(()=>{
    const box=document.querySelector('.proto-select');const btn=box?.querySelector('.proto-trigger');
    if(!box||!btn) return JSON.stringify({miss:true});
    return JSON.stringify({disabled:box.classList.contains('disabled'),btn:btn.disabled,value:box.querySelector('.proto-value')?.innerText,lock:!!box.querySelector('.proto-lock')})
  })()`))
  log(`[3] WARP 模式：禁用=${warpProto.disabled} 显示值="${warpProto.value}" 有锁标记=${warpProto.lock}`)
  if (warpProto.disabled) fail('WARP 模式下协议下拉框不该禁用')
  await ev(`(()=>{document.querySelector('.proto-trigger').click();return 1})()`)
  await sleep(300)
  const warpMenu = await ev(`document.querySelectorAll('.proto-option').length`)
  log(`[3] WARP 模式点击后菜单项=${warpMenu}`)
  if (!(warpMenu >= 6)) fail('WARP 模式协议菜单没有展开')
  await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-169-warp.png', Buffer.from(r.data, 'base64')))

  fs.writeFileSync(path.join(__dirname, '..', 'verify-home-1_6_9.log'), out.join('\n') + '\n')
  ws.close()
  log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
})().catch((e) => {
  fail(e.message)
  console.log('RESULT: FAIL')
})

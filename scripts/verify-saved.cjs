// 收藏页 + 国旗下拉的纯前端验收（vite preview + CDP）
const http = require('http')
const fs = require('fs')

const PORT = 9337
const URL = 'http://localhost:4173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(path) {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (r) => {
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
  await send('Page.enable')

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }

  await send('Page.navigate', { url: URL })
  await sleep(1200)

  // 造数据：订阅节点 + 已收藏节点
  const seed = await ev(`(() => {
    const node = (id, name, type, server, port) => ({ id, subId: 'sub-1', name, nodeType: type, server, port, config: 'vless://x@' + server + ':' + port })
    const raw = localStorage.getItem('antun-prefs')
    const box = raw ? JSON.parse(raw) : { state: {}, version: 0 }
    const st = box.state || {}
    st.settings = Object.assign({}, st.settings, { connMode: 'subscription', subSort: 'default', psiphon: false })
    st.page = 'home'
    st.subNodes = [
      node('n1', '台湾 中华电信 01', 'vless', '1.2.3.4', 443),
      node('n2', '新加坡 SG-02', 'trojan', '5.6.7.8', 8443),
      node('n3', '官方优选IP 104.16.1.1', 'vless', '104.16.1.1', 443),
      node('n4', '🇯🇵 东京 03', 'vless', '9.9.9.9', 443),
    ]
    st.savedNodes = [
      Object.assign(node('s1', '台湾 中华电信 01', 'vless', '1.2.3.4', 443), { id: 's1', source: '订阅导入', savedAt: Date.now() - 3000, delay: 168, speed: 2.4e6 }),
      Object.assign(node('s2', '🇯🇵 东京 03', 'vless', '9.9.9.9', 443), { id: 's2', source: '订阅导入', savedAt: Date.now() - 2000, delay: 92 }),
      Object.assign(node('s3', '德国 法兰克福 01', 'vless', '3.3.3.3', 443), { id: 's3', source: '订阅导入', savedAt: Date.now() - 1000 }),
    ]
    localStorage.setItem('antun-prefs', JSON.stringify(box))
    return st.savedNodes.length + '/' + st.subNodes.length
  })()`)
  console.log(`[0] 预置数据 ${seed}`)

  await send('Page.navigate', { url: URL })
  await sleep(1400)
  // 首次启动的免责弹窗会盖住页面：先点掉，否则截图全是遮罩
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '确定'); if (b) b.click(); return !!b })()`)
  await sleep(300)

  // [1] 首页下拉：国旗
  const pick = await ev(`(async () => {
    const trig = document.querySelector('.flag-trigger')
    if (!trig) return { err: 'no trigger' }
    const triggerFlag = trig.querySelector('img.flag')?.getAttribute('src') || trig.querySelector('svg.flag-none') ? 'icon' : 'none'
    trig.click()
    await new Promise(r => setTimeout(r, 250))
    const menu = document.querySelector('.flag-menu')
    if (!menu) return { err: 'no menu' }
    const opts = [...menu.querySelectorAll('.flag-option')].map(o => ({
      label: o.querySelector('.flag-option-label')?.textContent,
      img: o.querySelector('img.flag')?.getAttribute('src') || '',
      loaded: (() => { const i = o.querySelector('img.flag'); return i ? (i.complete && i.naturalWidth > 0) : false })(),
      globe: !!o.querySelector('svg.flag-none'),
      hint: o.querySelector('.flag-option-hint')?.textContent || '',
      group: o.closest('.flag-group')?.querySelector('.flag-group-label')?.textContent || '',
    }))
    trig.click()
    return { triggerFlag, total: opts.length, opts: opts.filter(o => o.group.includes('订阅')) }
  })()`)
  console.log(`[1] 首页下拉 触发图标=${pick.triggerFlag} 选项=${pick.total} ${pick.err ? "ERR=" + pick.err : ""}`)
  ;(pick.opts || []).forEach((o) => console.log(`    ${o.label} | ${o.img || (o.globe ? '地球' : '无图标')} | loaded=${o.loaded} | ${o.hint}`))

  // [2] 收藏页
  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('收藏')).click()`)
  await sleep(700)
  const saved = await ev(`(() => {
    const rows = [...document.querySelectorAll('.saved-row')]
    return {
      title: document.querySelector('.card-title')?.textContent || '',
      count: rows.length,
      rows: rows.map(r => ({
        name: r.querySelector('.with-flag span:last-child')?.textContent,
        flag: r.querySelector('img.flag')?.getAttribute('src') || '',
        loaded: (() => { const i = r.querySelector('img.flag'); return i ? (i.complete && i.naturalWidth > 0) : false })(),
        delay: r.children[4]?.textContent,
        speed: r.children[5]?.textContent,
      })),
      importBtn: !!document.querySelector('.saved-toolbar button'),
    }
  })()`)
  console.log(`[2] 收藏页 标题="${saved.title}" 行数=${saved.count}`)
  saved.rows.forEach((r) => console.log(`    ${r.name} | ${r.flag} loaded=${r.loaded} | delay=${r.delay} | speed=${r.speed}`))

  // [3] 勾选 + 批量删除按钮
  const bulk = await ev(`(async () => {
    const checks = [...document.querySelectorAll('.saved-row .saved-check')]
    checks[0].click(); checks[1].click()
    await new Promise(r => setTimeout(r, 150))
    const del = [...document.querySelectorAll('.saved-toolbar button')].find(b => b.className.includes('saved-del'))
    return { selected: document.querySelectorAll('.saved-row.selected').length, delText: del?.textContent || '' }
  })()`)
  console.log(`[3] 勾选 ${bulk.selected} 行，批量删除按钮="${bulk.delText}"`)

  // [4] 单行删除（不需要 confirm）
  const one = await ev(`(async () => {
    const before = document.querySelectorAll('.saved-row').length
    const rows = [...document.querySelectorAll('.saved-row')]
    const btn = [...rows[0].querySelectorAll('.saved-actions .icon-btn')].find(b => (b.title || '').includes('删除'))
    btn.click()
    await new Promise(r => setTimeout(r, 250))
    return { before, after: document.querySelectorAll('.saved-row').length }
  })()`)
  console.log(`[4] 单行删除 ${one.before} -> ${one.after}`)

  // [5] 从订阅导入
  const imp = await ev(`(async () => {
    const btn = [...document.querySelectorAll('.saved-toolbar button')].find(b => b.textContent.includes('从订阅导入'))
    btn.click()
    await new Promise(r => setTimeout(r, 200))
    const items = [...document.querySelectorAll('.saved-import-item')]
    const names = items.map(i => i.querySelector('.ellipsis')?.textContent)
    if (items.length) items[0].click()
    await new Promise(r => setTimeout(r, 150))
    const add = [...document.querySelectorAll('.saved-import button')].find(b => b.textContent.includes('加入收藏'))
    return { items: items.length, names, addText: add?.textContent || '', disabled: add?.disabled }
  })()`)
  console.log(`[5] 导入面板 可选=${imp.items} ${JSON.stringify(imp.names)} 按钮="${imp.addText}" disabled=${imp.disabled}`)

  const add = await ev(`(async () => {
    const add = [...document.querySelectorAll('.saved-import button')].find(b => b.textContent.includes('加入收藏'))
    add.click()
    await new Promise(r => setTimeout(r, 350))
    return { rows: document.querySelectorAll('.saved-row').length, msg: document.querySelector('.test-msg')?.textContent || '' }
  })()`)
  console.log(`[6] 加入收藏后 ${add.rows} 行，提示="${add.msg}"`)

  // [7] 搜索
  const search = await ev(`(async () => {
    const input = document.querySelector('.saved-search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '东京')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 250))
    return { rows: document.querySelectorAll('.saved-row').length, names: [...document.querySelectorAll('.saved-row .with-flag span:last-child')].map(s => s.textContent) }
  })()`)
  console.log(`[7] 搜索"东京" -> ${search.rows} 行 ${JSON.stringify(search.names)}`)

  // [8] 选用收藏节点 -> 首页下拉必须显示它（否则会误显示「未选择节点」）
  const usedName = await ev(`(async () => {
    const rows = [...document.querySelectorAll('.saved-row')]
    const btn = [...rows[0].querySelectorAll('.saved-actions .icon-btn')].find(b => (b.title || '').includes('选用'))
    const name = rows[0].querySelector('.with-flag span:last-child')?.textContent || ''
    btn.click()
    await new Promise(r => setTimeout(r, 300))
    return name
  })()`)
  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('首页')).click()`)
  await sleep(700)
  const picked = await ev(`(() => {
    const trig = document.querySelector('.flag-trigger')
    return {
      text: trig?.querySelector('.flag-value')?.textContent || '',
      flag: trig?.querySelector('img.flag')?.getAttribute('src') || '',
      hint: trig?.querySelector('.flag-trigger-hint')?.textContent || '',
    }
  })()`)
  console.log(`[8] 选用"${usedName}" -> 首页下拉="${picked.text}" 旗=${picked.flag} 提示="${picked.hint}"`)

  await ev(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('收藏')).click()`)
  await sleep(500)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('C:/Users/AA/AppData/Local/Temp/antun-saved.png', Buffer.from(shot.data, 'base64'))

  const pass = pick.total > 0 && saved.count === 3 && saved.rows.every(r => r.loaded) && bulk.selected === 2
    && one.after === one.before - 1 && imp.items === 2 && add.rows === 3 && search.rows === 1
    && picked.text === usedName && picked.flag.includes('/flags/')
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
  ws.close()
  process.exitCode = pass ? 0 : 1
})().catch((e) => { console.log('ERR', e.message); process.exitCode = 2 })

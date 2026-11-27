// 验收：模式页节点收藏按钮 + 首页扫描按钮给订阅节点测延迟并按延迟排序下拉
// 每一步一个短 CDP 会话（长连接会被 WebView 回收）
const http = require('http')

const PORT = 9343
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}

const goPage = (label) => ev(`(async () => {
  const nav = [...document.querySelectorAll('.nav-item, nav a, nav button')].find((e) => e.textContent.trim() === '${label}')
  nav?.click()
  await new Promise((r) => setTimeout(r, 700))
  return !!nav
})()`)

const state = () => ev(`(() => { const s = JSON.parse(localStorage.getItem('antun-prefs') || '{}').state || {}; return {
  saved: (s.savedNodes || []).length,
  subNodes: (s.subNodes || []).length,
  stats: Object.keys(s.nodeStats || {}).length,
  reachable: Object.values(s.nodeStats || {}).filter((x) => x.delay > 0).length,
  connMode: s.settings?.connMode,
  frontNodeId: s.settings?.frontNodeId,
} })()`)

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`[${results.length}] ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

;(async () => {
  // 0. 回首页，确认前置条件
  await goPage('首页')
  const s0 = await state()
  check('订阅模式且已有订阅节点', s0.connMode === 'subscription' && s0.subNodes > 0, `节点 ${s0.subNodes} · 已收藏 ${s0.saved}`)

  // 1. 模式页：每个节点行都有收藏按钮
  await goPage('模式')
  const modeShape = await ev(`(() => {
    const rows = [...document.querySelectorAll('.node-row.t')]
    return {
      rows: rows.length,
      withStar: rows.filter((r) => r.querySelector('.node-row-actions .icon-btn')).length,
      actionsWidth: rows[0]?.querySelector('.node-row-actions')?.getBoundingClientRect().width || 0,
    }
  })()`)
  check('模式页每行都有收藏按钮', modeShape.rows > 0 && modeShape.withStar === modeShape.rows,
    `${modeShape.withStar}/${modeShape.rows} 行`)

  // 2. 点第一行的星标 → 收藏状态翻转（不假设它原本是否已收藏，也不会改变选中节点）
  const pick = await ev(`(async () => {
    const read = () => JSON.parse(localStorage.getItem('antun-prefs') || '{}').state || {}
    const before = (read().savedNodes || []).length
    const rows = [...document.querySelectorAll('.node-row.t')]
    if (!rows.length) return { err: 'no rows' }
    const wasStarred = !!rows[0].querySelector('.icon-btn.starred')
    const name = rows[0].querySelector('.cell')?.textContent?.trim() || ''
    const front0 = read().settings?.frontNodeId
    rows[0].querySelector('.node-row-actions .icon-btn')?.click()
    await new Promise((r) => setTimeout(r, 900))
    const st = read()
    return {
      wasStarred, name, before,
      after: (st.savedNodes || []).length,
      starredNow: !!document.querySelectorAll('.node-row.t')[0]?.querySelector('.icon-btn.starred'),
      frontSame: front0 === st.settings?.frontNodeId,
      tip: document.querySelector('.test-msg')?.textContent?.trim() || '',
    }
  })()`)
  check('星标点击后收藏状态翻转', pick.starredNow === !pick.wasStarred,
    `${pick.wasStarred ? '已收藏 → 取消' : '未收藏 → 收藏'}${pick.tip ? ' · ' + pick.tip : ''}`)
  check('收藏数按预期变化', pick.after === pick.before + (pick.wasStarred ? -1 : 1), `${pick.before} → ${pick.after}`)
  check('点收藏按钮不会误切前置节点', pick.frontSame === true)

  // 3. 收藏页行数与收藏数一致
  await goPage('收藏')
  const savedPage = await ev(`(() => ({ rows: document.querySelectorAll('.saved-row').length }))()`)
  check('收藏页行数与收藏数一致', savedPage.rows === pick.after, `${savedPage.rows} 行 / 收藏 ${pick.after}`)

  // 4. 首页按钮在订阅模式下变为「测速节点」
  await goPage('首页')
  const btnText = await ev(`(() => document.querySelector('.home-node-pick-head button')?.textContent?.trim())()`)
  check('首页按钮文案为「测速节点」', btnText === '测速节点', btnText)

  // 5. 点测速，观察进入测试态
  await ev(`(() => { document.querySelector('.home-node-pick-head button')?.click(); return true })()`)
  await sleep(2500)
  const during = await ev(`(() => {
    const b = document.querySelector('.home-node-pick-head button')
    return { text: b?.textContent?.trim(), spin: !!b?.querySelector('svg.spin') }
  })()`)
  check('点击后进入测试中状态', during.spin === true, during.text)

  // 6. 等测速完成（延迟一次组调用，上百节点约十几秒）
  let done = null
  for (let i = 0; i < 40; i++) {
    await sleep(3000)
    const st = await state()
    const ui = await ev(`(() => {
      const b = document.querySelector('.home-node-pick-head button')
      return { text: b?.textContent?.trim(), spin: !!b?.querySelector('svg.spin') }
    })()`)
    if (!ui.spin) { done = { ...st, text: ui.text }; break }
  }
  check('测速在预算内结束', !!done, done ? `按钮回到「${done.text}」` : '超时')
  check('测到可用延迟', !!done && done.reachable > 0, done ? `测通 ${done.reachable}/${done.stats}` : '—')

  // 7. 下拉订阅组按延迟升序（未测的排最后）
  const order = await ev(`(async () => {
    const tr = document.querySelector('.flag-trigger')
    if (!tr) return { error: 'no trigger' }
    tr.click()
    await new Promise((r) => setTimeout(r, 500))
    const g = [...document.querySelectorAll('.flag-group')].find((x) => x.querySelector('.flag-group-label')?.textContent?.includes('订阅'))
    if (!g) return { error: 'no sub group' }
    const opts = [...g.querySelectorAll('.flag-option')].map((o) => ({
      label: o.querySelector('.flag-option-label')?.textContent || '',
      hint: o.querySelector('.flag-option-hint')?.textContent || '',
    }))
    document.querySelector('.flag-trigger')?.click()
    return { opts }
  })()`)
  if (order.error) {
    check('订阅下拉可展开', false, order.error)
  } else {
    const ms = order.opts.map((o) => {
      const m = /(\d+)\s*ms/.exec(o.hint)
      return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
    })
    const sorted = ms.every((v, i) => i === 0 || ms[i - 1] <= v)
    const head = order.opts.slice(0, 5).map((o) => `${o.label.replace(/\s+/g, '')}${o.hint ? '/' + o.hint : ''}`)
    check('订阅节点按延迟升序排列', sorted, head.join(' → '))
    check('前几项确实带延迟', ms.slice(0, 3).every((v) => v !== Number.MAX_SAFE_INTEGER), head.slice(0, 3).join(' · '))
  }

  // 8. 还原：第 2 步若是取消收藏，把它点回去，不动用户原有数据
  if (pick.wasStarred) {
    await goPage('模式')
    const restored = await ev(`(async () => {
      // 测速后排序可能变了，不能按行号找：找星标仍是空心（唯一未收藏）的那行
      const row = [...document.querySelectorAll('.node-row.t')].find((r) => !r.querySelector('.icon-btn.starred'))
      row?.querySelector('.node-row-actions .icon-btn')?.click()
      await new Promise((r) => setTimeout(r, 900))
      const st = JSON.parse(localStorage.getItem('antun-prefs') || '{}').state || {}
      return (st.savedNodes || []).length
    })()`)
    check('收藏状态已还原', restored === pick.before, `${restored} 个收藏`)
  } else {
    // 第 2 步是新收藏：收藏页按 savedAt 降序，第一条就是刚加的那条
    await goPage('收藏')
    const removed = await ev(`(async () => {
      document.querySelector('.saved-row .saved-actions .icon-btn.danger')?.click()
      await new Promise((r) => setTimeout(r, 900))
      const st = JSON.parse(localStorage.getItem('antun-prefs') || '{}').state || {}
      return (st.savedNodes || []).length
    })()`)
    check('收藏状态已还原', removed === pick.before, `${removed} 个收藏`)
  }

  const pass = results.every((r) => r.ok)
  console.log('\nRESULT:', pass ? 'PASS' : 'FAIL', `(${results.filter((r) => r.ok).length}/${results.length})`)
  process.exit(pass ? 0 : 1)
})().catch((e) => { console.log('ERR', e.message); process.exit(2) })

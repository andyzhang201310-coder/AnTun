/**
 * AnTun Tauri 桌面版验证脚本
 * 通过 WebView2 远程调试协议（CDP）连接运行中的 exe，执行真实交互验证。
 * 启动 exe 前需设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 */
const fs = require('fs')
const http = require('http')

const PORT = Number(process.env.CDP_PORT || 9222)

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

async function main() {
  const targets = await getJson('/json')
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('No page target found')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

  let seq = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const cmd = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text)
    return result.result?.result?.value
  }
  const clickText = (text) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b)b.click();return !!b})()`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  await cmd('Runtime.enable')
  await cmd('Page.enable')

  console.log('ROOT LEN:', await evaluate(`document.getElementById('root')?.innerHTML?.length || 0`))
  console.log('DESKTOP BRIDGE:', await evaluate(`JSON.stringify({bridge:!!window.AnTunDesktop,isDesktop:window.AnTunDesktop?.isDesktop,isTauri:window.AnTunDesktop?.isTauri,isElectron:window.AnTunDesktop?.isElectron,platform:window.AnTunDesktop?.platform})`))

  await clickText('确定')
  await sleep(400)
  await clickText('扫描端点')
  await sleep(2500)
  console.log('SCAN NODES:', await evaluate(`document.querySelectorAll('.node-row').length`))

  await evaluate(`(()=>{const b=document.querySelector('.pwr');if(b)b.click();return !!b})()`)
  await sleep(3500)
  console.log('CONNECTED:', await evaluate(`document.body.innerText.includes('已连接')`))
  console.log('HAS EXIT IP:', await evaluate(`/\\d+\\.\\d+\\.\\d+\\.\\d+/.test(document.body.innerText)`))

  for (const name of ['节点', '规则', '设置', '日志', '关于']) {
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(name)});if(b)b.click();return !!b})()`)
    await sleep(350)
    console.log('PAGE', name, 'TEXT LEN:', await evaluate(`document.querySelector('.page-wrap')?.innerText?.length || 0`))
  }

  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='首页');if(b)b.click();return !!b})()`)
  await sleep(500)
  const screenshot = await cmd('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('D:/VSCode/AnTun/tauri-verify.png', Buffer.from(screenshot.result.data, 'base64'))

  console.log('JS ERRORS:', JSON.stringify(errors))
  ws.close()
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })

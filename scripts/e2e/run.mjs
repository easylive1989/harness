#!/usr/bin/env node
// scripts/e2e/run.mjs — 送一段 async JS 給 driver.mjs 執行並印出結果
// 用法：node scripts/e2e/run.mjs '<code>'；沒有參數時從 stdin 讀；--quit 關閉 app 與 driver
// 環境變數 E2E_PORT 指定 driver 的 port（預設 47123）
// 用 node:http 而不是 fetch：等待 Claude 的指令可能跑好幾分鐘，fetch 預設 5 分鐘就逾時
import { request } from 'node:http'

const port = Number(process.env.E2E_PORT ?? '47123')
const quit = process.argv[2] === '--quit'
let code = quit ? '' : process.argv.slice(2).join(' ')
if (!quit && !code) {
  for await (const chunk of process.stdin) code += chunk
}

const body = await new Promise((resolveBody, reject) => {
  const req = request(
    { host: '127.0.0.1', port, method: 'POST', path: quit ? '/quit' : '/run' },
    (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolveBody(data))
    }
  )
  req.on('error', reject)
  req.end(code)
})

const out = JSON.parse(body)
if (out.ok) {
  const r = out.result
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
  console.error(`(${out.ms} ms)`)
} else {
  console.error(out.error)
  process.exitCode = 1
}

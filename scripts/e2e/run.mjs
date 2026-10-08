#!/usr/bin/env node
// scripts/e2e/run.mjs — 送一段 async JS 給 driver.mjs 執行並印出結果
// 用法：node scripts/e2e/run.mjs --dir <E2E 資料夾> '<code>'；沒有 code 時從 stdin 讀；
// --quit 關閉 app 與 driver。E2E 資料夾也可以用環境變數 E2E_DIR 指定，
// 環境變數 E2E_PORT 指定 driver 的 port（預設 47123）。
// 權杖從 <E2E 資料夾>/token 讀（driver 啟動時產生），放在 x-harness-e2e-token 標頭。
// 用 node:http 而不是 fetch：等待 Claude 的指令可能跑好幾分鐘，fetch 預設 5 分鐘就逾時
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
let dir = process.env.E2E_DIR
const at = args.indexOf('--dir')
if (at >= 0) {
  dir = args[at + 1]
  args.splice(at, 2)
}
if (!dir) {
  console.error("用法：node scripts/e2e/run.mjs --dir <E2E 資料夾> '<code>'（或設定 E2E_DIR）")
  process.exit(1)
}
let token
try {
  token = readFileSync(join(dir, 'token'), 'utf8').trim()
} catch {
  console.error(`讀不到 ${join(dir, 'token')}：driver.mjs 是否已用 --dir ${dir} 啟動？`)
  process.exit(1)
}

const port = Number(process.env.E2E_PORT ?? '47123')
const quit = args[0] === '--quit'
let code = quit ? '' : args.join(' ')
if (!quit && !code) {
  for await (const chunk of process.stdin) code += chunk
}

const { status, body } = await new Promise((resolveBody, reject) => {
  const req = request(
    {
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: quit ? '/quit' : '/run',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-harness-e2e-token': token
      }
    },
    (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolveBody({ status: res.statusCode, body: data }))
    }
  )
  req.on('error', reject)
  req.end(code)
})

let out
try {
  out = JSON.parse(body)
} catch {
  out = { ok: false, error: `driver 回應 ${status}：${body}` }
}
if (out.ok) {
  const r = out.result
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
  console.error(`(${out.ms} ms)`)
} else {
  console.error(out.error)
  process.exitCode = 1
}

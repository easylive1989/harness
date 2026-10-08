#!/usr/bin/env bash
# scripts/create-demo-repo.sh — 建立一個小型 Node 專案供端對端驗證
# 用法：scripts/create-demo-repo.sh [目標資料夾]（預設 ~/harness-demo）
set -euo pipefail
DIR="${1:-$HOME/harness-demo}"
# 只覆蓋之前由這個腳本建立的資料夾，避免打錯路徑時刪掉其他東西
if [ -e "$DIR" ] && ! grep -qs '"name": "harness-demo"' "$DIR/package.json"; then
  echo "拒絕覆蓋：$DIR 已存在且不是示範 repo" >&2
  exit 1
fi
rm -rf "$DIR" && mkdir -p "$DIR/src" "$DIR/test" "$DIR/.claude"
cd "$DIR"
cat > package.json <<'JSON'
{ "name": "harness-demo", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > src/login.js <<'JS'
const users = new Map([['alice', 'secret']])
export function login(username, password) {
  if (users.get(username) === password) return { ok: true }
  return { ok: false, status: 401 }
}
JS
cat > test/login.test.js <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { login } from '../src/login.js'
test('正確密碼可以登入', () => assert.deepEqual(login('alice', 'secret'), { ok: true }))
test('錯誤密碼回 401', () => assert.equal(login('alice', 'x').status, 401))
JS
# 專案層級的 allow 規則：用來驗證 Harness 的 PreToolUse hook 仍會要求核准 npm test、釐清階段仍不能改檔
cat > .claude/settings.json <<'JSON'
{ "permissions": { "allow": ["Bash(npm test:*)", "Bash(npm test)", "Edit"] } }
JSON
printf '# harness-demo\n' > README.md
git init -q -b main && git add -A && git commit -q -m "init demo"
echo "demo repo: $DIR"

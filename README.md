# Harness

個人用的 macOS 桌面 app：選一個 git repo，用聊天描述需求，Claude 透過問題卡片釐清方向與細節（可以在卡片裡反問，也可以開分岔深入討論、再把結論帶回主線）；你核准規格後，Claude 在獨立的 git worktree 裡實作；完成後 Harness 產生 HTML 報告，呈現新增的測試、架構前後對照、決策與原因、限制、程式碼變更（diff 與修改原因）和由 Harness 實際重跑的測試結果。你可以在報告上逐段、逐行留回饋產生新版本，最後開 PR、合併或丟棄。

Harness 透過本機已登入的 Claude Code（訂閱方案）運作，不使用 API key。介面為繁體中文。

## 需求

- macOS
- Node.js 22 以上
- git（需要 `git worktree`；建議 2.20 以上）
- [Claude Code](https://docs.claude.com/en/docs/claude-code) 已安裝，並在終端機執行過 `claude` 完成登入（訂閱方案）
  - 不需要 API key。環境裡的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、`CLAUDE_CODE_USE_FOUNDRY` 會被忽略（不傳給 Claude Code），設定頁會說明忽略了哪些。
  - 測試過的 Claude Code CLI 版本：2.1.293–2.1.294。Harness 用環境變數 `CLAUDE_CODE_TERMINAL_MCP_TOOLS` 讓 Claude Code 在 Claude 呼叫提問、規格、結論、報告工具後不再催它補一段文字；這個變數不是公開的設定，而是 CLI 內部的行為，之後的版本可能改變。
- 要開 PR 的話：[GitHub CLI](https://cli.github.com/)（`gh`）已用 `gh auth login` 登入，且 repo 有 `origin` 遠端

## 指令

```bash
npm install            # 安裝相依套件
npm run dev            # 開發模式啟動 app
npm test               # 單元、整合與元件測試（Vitest）
npm run typecheck      # 型別檢查（main／preload 與 renderer）
npm run lint           # ESLint
npx electron-vite build  # 建置到 out/（手動端對端驗證用）
```

app 不打包、沒有程式碼簽章與自動更新，用 `npm run dev`（或建置後用 `npm start` 預覽）在本機執行。

## 資料放在哪裡

- 設定、repo 清單、任務、時間軸與報告：Electron 的 userData 底下的 `harness/`（一般是 `~/Library/Application Support/harness/harness/`）
  - `settings.json`、`repos.json`
  - `tasks/<任務 id>/task.json`、`timeline.jsonl`、`reports/v<n>.json`
- 任務的 worktree：預設 `~/.harness/worktrees/<repo>/<日期>-<代號>`，分支 `harness/<日期>-<代號>`（設定頁可改位置與分支前綴）
- 環境變數 `HARNESS_USER_DATA_DIR` 可以把 userData 換到別的資料夾（驗證或試用時不碰真正的資料）

## 手動端對端驗證

`scripts/e2e/` 是用 Playwright 的 Electron 支援驅動建置好的 app 的工具，不屬於 `npm test`，會呼叫真正的 Claude（用掉訂閱額度）。所有資料都放在你指定的資料夾：

```bash
npx electron-vite build
node scripts/e2e/driver.mjs --dir <暫存資料夾> --fresh      # 建立示範 repo、settings.json，啟動 app
node scripts/e2e/run.mjs --dir <暫存資料夾> 'await shot("01-settings"); return state()'
node scripts/e2e/run.mjs --dir <暫存資料夾> --quit
```

- `driver.mjs` 在 `127.0.0.1:47123`（`--port` 可改，`run.mjs` 用 `E2E_PORT`）接收一段段 async JS，可用 `page`、`shot`、`state`、`waitIdle`、`stubOpen` 等 helper（見檔案開頭的說明）。
- 指令伺服器會執行收到的程式，所以只接受帶權杖的請求：啟動時產生隨機權杖寫到 `<暫存資料夾>/token`（權限 0600，結束時刪除），`run.mjs` 讀它放在 `x-harness-e2e-token` 標頭。沒有權杖、帶 `Origin`（瀏覽器發出的請求）、Host 不對、不是 POST 或路徑不是 `/run`、`/quit` 的請求一律拒絕。`--dir` 也可以改用環境變數 `E2E_DIR`。
- 示範 repo：`scripts/create-demo-repo.sh [目標資料夾]`（預設 `~/harness-demo`）建立一個小型 Node 專案（登入函式與 `node --test` 測試），`driver.mjs --fresh` 會自動建在 `<暫存資料夾>/harness-demo`。它的 `.claude/settings.json` 刻意允許 `npm test` 與 `Edit`，用來確認 Harness 的權限規則不會被專案設定繞過。

驗證紀錄見 [`docs/verification.md`](docs/verification.md)。

## 安全模型

Harness 不是沙箱：核准過的指令以你的權限執行。它做的是把 Claude 能做的事限縮到可以看見、可以核准的範圍。

- **隔離**：每個任務一個 worktree 與新分支；Claude 只在 worktree 裡工作，原 repo 直到你按「合併」才會變動。
- **階段**：釐清、規格與分岔是唯讀的，只能讀檔與搜尋（`Read`、`Glob`、`Grep`）；`WebFetch`／`WebSearch` 每次都要你核准；其他工具一律拒絕。
- **實作**：worktree 內的檔案讀寫自動允許，worktree 外一律拒絕（路徑先解開 symlink 再比對）。修改 `.git`、`.claude/`、`.mcp.json` 與 git hooks（`.husky/`、`.githooks/`、lefthook、`.pre-commit-config.yaml`、repo 設定的 `core.hooksPath`）要你核准。shell 指令要核准，除非符合設定頁的永遠允許清單或本任務允許的樣式（例如 `npm test *`）；含 ``; & | ` < > $`` 或換行的指令一律逐次核准。
- **規則不會被專案設定繞過**：硬性規則由 PreToolUse hook 執行（專案 `.claude/settings.json` 的 allow 規則在 `canUseTool` 之前生效）；Harness 自己的 MCP 工具只信任 app 在程序內註冊的那一個。不載入 claude.ai 帳號上的連接器。
- **報告**：diff、統計與測試結果由 Harness 產生，不採信 Claude 的自述；驗證指令只重跑本任務核准過或在允許清單中的指令。Claude 的自訂視覺化區塊放在沒有 same-origin、禁止網路的 sandbox iframe 裡。
- **提交報告時的自動 commit 不執行任何 git hook**（`--no-verify` 加 `core.hooksPath=/dev/null`）：hook 是 worktree 裡 Claude 改得到的檔案，由 app 執行等於讓 Claude 不經核准就跑程式。

### 已知的限制

- **合併與 push 照常執行 repo 的 git hooks**（pre-push、pre-merge-commit、post-merge…）：這兩個操作是你看過報告與 diff 之後才按的。按之前請確認 diff 裡沒有你不認得的 hook 變更（修改 hook 檔案時 Harness 已要求核准，但也要留意 hook 會呼叫的腳本，例如 `package.json` 的 scripts）。
- **核准專案腳本的樣式等於允許它執行的任何內容**：勾選「本任務內都允許 `npm test *`」之後，Claude 可以改 `package.json` 的 scripts（或腳本本身）改變 `npm test` 實際跑什麼，之後不會再詢問；提交報告時 Harness 也會重跑它。Harness 只比對指令文字，不看指令會執行的檔案。對 `rm`、`curl`、`sudo`、`git diff`、`git log`、`git push`，核准對話框只建議記住完全相同的指令，範圍很廣或有危險的樣式會顯示提醒。
- **權限規則只涵蓋 Claude 的工具呼叫**：核准過的指令不受 worktree 限制（可以讀寫任何你能存取的檔案、連網）。repo 自己的 `.claude/settings.json`（包含專案的 hooks 與 MCP）會被載入（設定頁可以關閉），它們是 repo 的一部分，不經過 Harness 的核准。
- Claude Code 的版本相依：見「需求」中的 `CLAUDE_CODE_TERMINAL_MCP_TOOLS`。

## 文件

- [設計文件](docs/plans/2026-10-07-harness-design.md)：架構、狀態機、權限、報告與錯誤處理
- [實作計畫](docs/plans/2026-10-07-harness-implementation.md)：逐步的 Task 與各檔案的最終程式碼
- [端對端驗證紀錄](docs/verification.md)
- [畫面設計稿](docs/design/)

# 端對端驗證紀錄（Task 35）

日期：2026-10-08
方式：以 `scripts/e2e/driver.mjs`（Playwright 的 Electron 支援）啟動 `npx electron-vite build` 的產物，透過真實介面操作（點擊、輸入、截圖），由真實 Claude Code（訂閱方案）回應。資料全部放在暫存資料夾（`HARNESS_USER_DATA_DIR`、暫存的 worktree 位置與示範 repo），沒有碰到使用者的 `~/Library/Application Support/harness` 與 `~/.harness`（驗證後檢查過，沒有任何今天修改的檔案）。

截圖存在暫存資料夾的 `e2e/shots/`，不進版控（設定頁會顯示帳號 email）。

## 版本

| 項目 | 版本 |
|---|---|
| Harness | 1.0.0（分支 `feat/harness-app`） |
| Electron | 39.8.10（Chromium 142、Node 22.22.1） |
| Claude Code CLI | 2.1.293 |
| @anthropic-ai/claude-agent-sdk | 0.3.292 |
| Playwright | 1.64.0 |
| 模型 | 任務 1、2：Opus 5.5（`claude-opus-5-5`）；任務 3：Sonnet 5.5（`claude-sonnet-5-5`，順便驗證每個任務可選模型） |
| 帳號 | Max 方案 |

## 驗證的任務

1. 「登入連續失敗 3 次就鎖定帳號 1 分鐘」（Opus）：釐清（2 題、1 次反問、1 個分岔）→ 規格 v1 → 要求修改 → v2 → 實作（插話）→ 報告 v1 → 回饋 → 報告 v2 → 合併。
2. 「README 加上安裝與執行測試的說明」（Opus）：釐清中要求 Claude 試著改檔、釐清中關閉 app 再續接、實作、報告、丟棄。
3. 「新增 docs/lockout.md…報告附狀態轉換圖」（Sonnet）：驗證 Glob／Grep 修正與自訂視覺化區塊、含自訂區塊的匯出。

## 檢查項目

| # | 結果 | 觀察 | 截圖 |
|---|---|---|---|
| 1 | ✅ | 設定頁顯示「已透過 Claude Code 登入 · Max 方案」、CLI 路徑與版本、帳號。 | `01-settings` |
| 2 | ✅ | 用 stub 的選資料夾對話框加入示範 repo；輸入需求、模型 Opus 5.5 後開始釐清。worktree 建在暫存的 worktreeRoot 下（`worktrees/harness-demo/20261008-cd762167`，分支 `harness/20261008-cd762167`）。 | `02-new-task`、`03-clarify-start` |
| 3 | ✅ | 問題卡片出現，建議選項有「建議」標記。讀檔摘要：任務 2 顯示「讀取 2 次」；任務 1 Claude 改用 Explore 子代理讀檔，時間軸只顯示「子代理 1 次」。第一次執行發現 harness 工具參數錯誤與找不到檔案的問題，見下方「發現並修正的問題」1–3。 | `04-first-question`、`37-task2-first` |
| 4 | ✅ | 反問「423 和 429 哪個符合慣例？」→ 卡片內出現 Claude 的回答，建議從 423 改成 429、選項順序與說明更新。回答原本以純文字顯示 Markdown 符號，已修正（問題 4）。 | `06-counter-answered`、`07-counter-markdown` |
| 5 | ✅ | 在 Claude 訊息上按分岔 → 右側面板出現分岔與回覆 → 再討論一輪 → 帶回主線 → 預覽結論 → 確認 → 主線出現黃色「分岔…的結論」決策，Claude 採納並繼續。 | `09-branch-replied`、`10-branch-conclusion-preview`、`12-main-decision` |
| 6 | ✅ | 回答第 2 題後 Claude 提出規格，自動切到規格頁（決策來源標籤：問題 1／分岔／問題 2）。要求修改（一併修掉空密碼漏洞）→ 出現 v2（版本下拉）→ 核准。 | `13-spec-v1`、`15-spec-v2` |
| 7 | ✅ | 步驟清單隨 `update_plan` 更新；`npm test` 跳出核准框 → 勾「本任務內都允許 npm test *」→ 允許；插話後 Claude 再跑 `npm test` 沒有再詢問。任務 2 另外驗證「拒絕並說明」（`git ls-files` → 「不需要，用 Glob 就好」，時間軸顯示「已拒絕」）與只允許一次。 | `17-permission-dialog`、`43-task2-permission2` |
| 8 | ✅ | 核准 `npm test` 後立刻插話「錯誤訊息用繁體中文」→ Claude 在失敗回傳加上繁體中文 `message`，改測試、重跑 `npm test`，並在報告記成決策 D6（來源：插話）。 | `18-interjected`、`19-after-interject` |
| 9 | ✅ | 概觀數字（2 檔、+106 −4、驗證 1/1 通過、6 個決策）；架構前後圖新增節點為青綠色、修改為藍框；決策卡片的「問題 1」可回到釐清對話；限制與後續；diff 每檔與每段 hunk 都有「為什麼」；測試結果標示「由 Harness 在 worktree 中實際執行」，`npm test` 的輸出與耗時來自 VerifyRunner。任務 3 的自訂區塊在 `harness-block://` iframe（`sandbox="allow-scripts"`）正常顯示，高度 254px 等於內容高度。 | `20-report-v1`、`21`–`24-report-*`、`25-decision-to-question`、`50-custom-block` |
| 10 | ✅ | 對 `src/login.js:17` 與決策 D6 留回饋 → 回饋面板列出 2 則 → 送出 → 任務回到實作 → 產生 v2（10 個測試通過、429 訊息已改、username 也驗證）。版本下拉可切換 v1／v2，看 v1 時提示「舊版本，只能看」。 | `26-line-comment`、`27-decision-comment`、`30-report-v2`、`31-report-v1-selected` |
| 11 | ✅ | 以 stub 的存檔對話框匯出 → 在另一個 Chromium 視窗打開：版面完整（概觀、架構圖、決策、限制、diff、測試），沒有任何 `<button>`／輸入框。任務 3 的匯出含自訂區塊（srcdoc iframe，高度一樣自適應）。 | `33-export-top`、`34-export-part*`、`51-export-custom-block` |
| 12 | ✅ | 合併前示範 repo 的 main 工作目錄乾淨、只有 `init demo`；按「合併到 main」→ `git log` 出現 `Merge harness/20261008-cd762167`（含報告 v1、v2 兩個 commit）；任務顯示「已合併」。 | `36-merged` |
| 13 | ✅ | 任務 2 在釐清中送出訊息、Claude 執行中時關閉 app → 重新啟動後側欄顯示「已中斷」，畫面有「上一次執行被中斷了。繼續」→ 按繼續後 Claude 接著處理中斷前的要求（加上 MIT 授權段落）並提出規格 v2。 | `39-interrupted`、`41-resumed` |
| 14 | ✅（有限制） | 任務 2 走到報告後按「丟棄 worktree」→「確定丟棄」→ worktree 資料夾與分支 `harness/20261008-d677a8af` 被刪除，任務從側欄消失，報告仍可看。**介面上只有報告頁有丟棄按鈕**，釐清／規格／實作中的任務無法從介面丟棄（見「未解決」）。 | `45-discard-confirm`、`46-discarded` |
| 15 | ✅ | 示範 repo 的 `.claude/settings.json` 允許 `Bash(npm test:*)`、`Bash(npm test)`、`Edit`。實作中 `npm test` 仍跳出 Harness 的核准框（PreToolUse hook 回 ask）。釐清中 Claude 自行嘗試 `Bash`（`git ls-files`、`grep`）都被拒；任務 2 請 Claude 在釐清中用 Edit 改 README → 「PreToolUse:Edit hook error: 目前不是實作階段，不能修改檔案」。三個任務核准規格前 worktree 都是乾淨的。 | `17-permission-dialog`、`38-edit-denied-clarify` |
| 16 | — 未發生 | 三個任務中 Claude 都沒有寫入 `.git`、`.claude/`、`.mcp.json`，沒有刻意要求，未驗證（規則已有單元測試）。 | — |

其他確認：
- 釐清到合併前，示範 repo 的工作目錄與 main 分支都沒有變動，變更只在 worktree。
- 報告的驗證指令確實由 app 重跑：報告 JSON 的 `verification` 有 exit code、耗時與輸出尾段；只允許一次（未勾記住）的 `npm test` 也因為在本任務核准過而重跑。
- 修正後的新 session（任務 2、3）沒有任何 harness 工具參數錯誤，也沒有 claude.ai 連接器。

## 發現並修正的問題

| # | 問題 | 根本原因 | 修正 commit |
|---|---|---|---|
| 1 | 第一輪 Claude 呼叫 `ToolSearch` 想載入 harness 工具的 schema 被拒，接著用錯參數呼叫 `ask_user`（缺 `question_id`），時間軸出現紅色工具錯誤。 | Claude Code 2.1.x 會把 MCP 工具藏在 tool search 後面，`ToolSearch` 不在允許清單。 | `3b65e7e` fix(main): allow ToolSearch so Claude can load harness tool schemas |
| 2 | 之後 `conclude_branch`、`propose_spec`、`update_plan`、`submit_report` 仍反覆因參數格式錯誤失敗後重試。 | harness 工具預設被延後載入，Claude 沒看到 schema 就猜。以 SDK 探測確認 `alwaysLoad: true` 才會把 schema 放進 prompt。 | `5c12247` fix(main): always load harness tool schemas into the prompt |
| 3 | 釐清中 Claude 找不到檔案：只能猜路徑（任務 3 還反問使用者程式碼在哪個檔案）。 | Claude Code 2.1.x 預設不提供 Glob／Grep（改用 Bash 搜尋），而釐清階段禁止 Bash。改為以 `tools` 明確列出 PermissionGate 有規則的內建工具（也順便移除 Cron、Worktree、Workflow 等一律被拒的工具）。修正後任務 3 直接用 Glob／Grep 找到 `src/login.js`（`48-task3-glob`）。 | `2e05c0b` fix(main): offer Glob and Grep explicitly so Claude can explore in clarify |
| 4 | 問題卡片內 Claude 對反問的回答顯示 `**`、反引號等 Markdown 原始符號。 | 卡片用純文字顯示 followup。改用 Markdown 元件。 | `0b1cb66` fix(ui): render Claude's counter-question replies as Markdown |
| 5 | 每個 session 都載入使用者 claude.ai 帳號上的連接器（Gmail、Notion、Docs…，約 68 個延後載入的工具），Claude 甚至在回覆中提到它們。 | CLI 預設載入 claude.ai 連接器；PermissionGate 本來就全部拒絕。啟動 CLI 時加 `ENABLE_CLAUDEAI_MCP_SERVERS=false`。 | `e3a9107` fix(main): do not load claude.ai connectors into Harness sessions |

另外新增：`d5d23ec` feat(main): allow overriding userData via HARNESS_USER_DATA_DIR（驗證用的資料隔離）。

## 未解決／觀察

Task 37（端對端驗證後的體驗修正）處理了大部分項目；修正以預先寫入的資料啟動建置好的 app 驗證（不呼叫真的 Claude，截圖不進版控）。提示的調整（語言、不重述問題）與 `conclude_branch` 的主題要在下一次真實 Claude 驗證時確認效果。

- ~~只有報告頁能丟棄任務~~ → 已修正：任務標題列（階段切換旁）的「⋯」選單在每個階段都能丟棄（兩段式確認、執行中先停止 Claude、整理報告中不能丟棄，丟棄後回到新任務頁）；已完成的任務只能清除 worktree；報告頁的收尾面板只留開 PR 與合併。`3137f4c` feat(ui): discard a task from any stage、`9813143`（丟棄完成前換了畫面就不拉回新任務頁）
- ~~決策卡片的「問題 N」停在時間軸最底部~~ → 已修正：報告與規格的「問題 N」（含規格右側的釐清紀錄）切到釐清畫面、捲到那個問題並短暫標示 2 秒（減少動態時不做動畫）。`2c38840` feat(ui): jump to the question from the spec and the report
- ~~重新提問還開著的卡片留在原本的位置~~ → 已修正：除了回答反問，`ask_user` 一律在時間軸最新的位置放一筆，畫面只畫最後一張。`6dcaaa4` fix(main): move a re-asked question card to the latest position；卡片以問題 id 為 key，搬到新位置時還沒送出的輸入留著：`3d07ce2` fix(ui): keep a re-asked question card's unsent input
- ~~架構圖在 1440px 下最右邊的節點被裁掉、文字縮到約 8px~~ → 已修正：前後兩欄放不下縮到 0.6 倍的圖時上下排列（1440px：原尺寸；1100px：約 0.68 倍，都不需要水平捲動）。`a5fbe09` fix(ui): stack the architecture diagrams when the column is too narrow；同時修正 1100px 時決策卡片標題被擠成一字一行：`fa21a12` fix(ui): let decision card headers wrap at narrow widths
- ~~從 Claude 訊息分岔時標題取訊息前 24 字~~ → 已修正：先在分岔面板問「想針對這段討論什麼？」（引用那則訊息），送出才建立分岔，標題是使用者的問題；`conclude_branch` 可以用 `title` 換成 10–20 字的主題。`cb1a4eb` feat(ui): ask what to discuss before branching from a message、`5460fb9` feat: let conclude_branch retitle the branch；手動驗證時另外修正 `b8081cf`（表單裡任何地方按 Esc 都取消）、`1d8c324`（取消後分岔訊息捲回最底）；審閱後修正 `f26e6d6`（從問題卡片換分岔時放棄草稿、建立中不能取消、焦點、換訊息重新開始）、`b7fd28a`（標題太長或空白時截斷／保留原標題，不拒絕整個結論）
- harness 工具的 schema 驗證錯誤（Claude 會自行修正）仍以紅色「工具錯誤」顯示在時間軸（未處理）。~~`propose_spec` 的決策來源沒有「規格回饋／插話」類型~~ → 已修正：決策來源新增 `user`，介面顯示「你的指示」。`9defffe` feat: add the user decision source、`52a6e60`（摘錄也給螢幕閱讀器）
- Claude 偶爾用英文寫過場句、在文字裡重述問題（「我已經在介面上送出第一個問題…」）→ 提示已調整（全程繁體中文含過渡語句；問題、選項、規格與報告只放在工具參數裡，不重述、不說已送出），待真實 Claude 驗證。`bc739e7` feat(main): keep narration in Traditional Chinese and stop restating cards
- 重新啟動 app 後第一次打開任務時，有一次時間軸停在最上面 → 原因仍不明；`useStickToBottom` 改成時間軸從空變成有內容時一定捲到底（不受讀取期間的捲動事件影響）。手動驗證重開 app 時在最底。`8915478` fix(ui): scroll a timeline to the bottom when it first loads
- 第 16 項（寫入受保護路徑時核准）沒有自然發生，未驗證。

## 耗時

- 真實 Claude 執行時間約 12–13 分鐘（各輪等待時間加總：任務 1 約 8 分鐘、任務 2 約 2.5 分鐘、任務 3 約 2 分鐘，另有 6 次各約 15 秒的 SDK 探測）。
- 實際經過時間約 40 分鐘（11:06–11:44，包含除錯、修正與重新建置）。

## 重跑方式

```bash
npx electron-vite build
node scripts/e2e/driver.mjs --dir <暫存資料夾> --fresh   # 建立示範 repo、settings.json，啟動 app
node scripts/e2e/run.mjs 'await shot("01-settings"); return state()'
node scripts/e2e/run.mjs --quit
```

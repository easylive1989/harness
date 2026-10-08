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
node scripts/e2e/run.mjs --dir <暫存資料夾> 'await shot("01-settings"); return state()'
node scripts/e2e/run.mjs --dir <暫存資料夾> --quit
```

驅動程式的指令伺服器（`127.0.0.1:47123`，`--port` 可改，`run.mjs` 用 `E2E_PORT`）執行收到的 JS，所以只接受帶權杖的請求：啟動時產生隨機權杖寫到 `<暫存資料夾>/token`（權限 0600，結束時刪除），`run.mjs` 讀它放在 `x-harness-e2e-token` 標頭；沒有權杖或權杖不對（401）、帶 `Origin` 標頭（瀏覽器發出的請求，403）、Host 不是 `127.0.0.1:<port>`（403）、不是 POST（405）或路徑不是 `/run`、`/quit`（404）的請求一律拒絕（2026-10-08 總審查後加上）。`--dir` 也可以改用環境變數 `E2E_DIR`。

## 第二輪端對端驗證（新增的測試、分岔主題、提示調整）

日期：2026-10-08（13:41–14:20）
方式：同上（`scripts/e2e/driver.mjs`、暫存的 userData／worktree／示範 repo，截圖在暫存資料夾的 `e2e2/shots/`，不進版控）。驗證後確認 `~/Library/Application Support/harness` 沒有任何 13:30 之後修改的檔案，`~/.harness` 不存在；示範 repo 的 main 仍只有 `init demo`、工作目錄乾淨。
版本：Claude Code CLI 2.1.294（其餘同上）；模型一律用預設的 Opus 5.5。

驗證的任務：
1. 「登入連續失敗 3 次就鎖定帳號 1 分鐘」：釐清（1 題，帶回分岔結論後重新提問一次）→ 從 Claude 訊息分岔 → 帶回主線 → 回答 → 規格 v1 → 核准 → 實作（`npm test` 勾「本任務內都允許」）→ 報告 v1（停在待審閱，沒有開 PR、沒有合併）。
2. 「README 加上安裝與執行測試的說明」（修正後）：Claude 直接提出規格 → 要求修改「請先用問題卡片問我」→ 回到釐清、出現問題卡片 → 從「⋯」丟棄。
3. 「登入成功時回傳使用者名稱」（修正後）：釐清 → 從訊息分岔兩次、各自帶回主線（第二個不確認）→ 從「⋯」丟棄。

| # | 結果 | 觀察 | 截圖 |
|---|---|---|---|
| A 報告的「新增的測試」 | ✅ | 區塊緊接在概觀之後（之後才是架構、決策、diff、測試結果），概觀「新增測試 6」。6 個測試都有名稱、`test/login.test.js:行號`、「新增」「單元」標籤，情境是「alice 連續輸錯 3 次（每次都回 401）→ 立刻用正確密碼登入 → 預期得到 { ok: false, status: 423, retryAfter: 60 }」的寫法；驗證列是 VerifyRunner 重跑的「`npm test` 通過」。沒有「未說明」（新增的 `setup()` 輔助函式在測試檔裡，沒有另外的 fixture／helper 檔）。這次 Claude 沒有改既有的測試，「修改」標籤沒有出現。點測試名稱 → diff 捲到 `test/login.test.js` 第 22 行、焦點在那一行；這時發現整個視窗往上移 16px（問題 3，已修正）。 | `13-report-top`、`14-test-jump-diff`、`17-test-jump-fixed` |
| B PR 內文 | ✅ | 以 `npx -y tsx --tsconfig tsconfig.node.json <暫存>/prbody-check.ts <userData>/harness/tasks/<id>/reports/v1.json` 對存下的報告呼叫 `prBody`：順序是摘要 → 新增的測試（6 項：粗體名稱、`test/login.test.js`、情境）→ 決策 → 限制與風險 → 後續工作 → 驗證（✅ `npm test`）→ 變更統計。 | `e2e2/prbody-v1.md` |
| C 從訊息分岔 | ✅ | 按訊息旁的分岔 → 分岔面板出現引用與「想針對這段討論什麼？」；送出後分岔標題是我的問題（超過 30 字截斷成「鎖定 1 分鐘從第 3 次失敗開始算，還是之後每次失敗都重新」）。帶回主線時 Claude 用 `title` 給了「鎖定計時起點與是否重新計時」，待確認時標籤就換了，確認後標籤「…· 已帶回」、主線決策「分岔「鎖定計時起點與是否重新計時」的結論」。任務 3 的兩個分岔也都換成 Claude 的主題（「既有登入測試的預期值調整方式」「回傳值是否帶登入時間」，10–14 字）。 | `04-branch-composer`、`05-branch-replied`、`06-branch-conclusion-preview`、`08-main-decision-chip`、`28-task3-chip-after-conclude` |
| D 提示的效果 | ❌ → ✅（修正後） | 三個任務 14 段 Claude 文字全部是繁體中文，程式碼以外沒有英文句子。修正前：呼叫 `ask_user` 後問題卡片下面又出現一段話（「我先讀過了 `src/login.js`…所以想先確認你的選擇」「我已經把剛才的分岔結論併進去了…」）。transcript 顯示 Claude 本來照指示不寫字就結束，是 Claude Code 補了「[Your previous response had no visible output…]」逼它寫（問題 1）；分岔裡呼叫 `conclude_branch` 後把整個結論用文字再寫一次（問題 2）；分岔回覆結尾寫「送出 [conclude] 我就把結論帶回主線」（問題 4）。另外有一次連續兩次用同樣參數呼叫 `ask_user`（畫面只有一張卡片）。修正後四個新 session（任務 2 主線、任務 3 主線與兩個分岔）都沒有出現催促，問題卡片後面沒有文字（任務 2、任務 3 兩次），第二個分岔的回覆沒有提到標記、帶回主線後沒有文字。仍有的小問題見「未解決」。 | `03-first-question`、`07-after-conclusion`（修正前）；`21-task2-question`、`25-task3-first`、`29-task3-branch2`（修正後） |
| E 從「⋯」丟棄 | ✅ | 任務 2（釐清中、有開放的問題）：「⋯」→「丟棄任務」→ 確認文字含分支名稱 →「確定丟棄」→ 回到新任務頁、側欄不再列出、`task.json` 是 `discarded`；worktree 資料夾 `20261008-38e8906b` 與分支 `harness/20261008-38e8906b` 都刪除（`git worktree list` 只剩 main 與任務 1）。任務 3（釐清中、分岔結論待確認）同樣丟棄乾淨。 | `22-task-menu`、`23-discard-confirm`、`24-discarded`、`31-task3-discarded` |
| F 重新提問移到最新位置 | ✅（自然發生） | 帶回分岔結論後 Claude 用同一個 question_id 重新送出問題（建議從 423 改成 423＋retryAfter），卡片出現在分岔結論之後的最底部，原位置沒有重複的卡片。任務 3 也一樣。 | `07-after-conclusion`、`28-task3-chip-after-conclude` |
| G 錯誤 | ✅（有一個介面問題已修正） | renderer 主控台沒有 error／warning；主程序 stderr 只有偵錯器中斷與 macOS 的 `representedObject is not a WeakPtrToElectronMenuModelAsNSObject`。時間軸唯一的紅色工具錯誤是任務 1 釐清時 Claude 先試 `git ls-files` 被拒（「PreToolUse:Bash hook error: 目前不是實作階段，不能執行指令。」，預期的拒絕）；沒有 harness 工具的參數錯誤。報告頁可以把整個視窗捲走（問題 3）。 | `16-wheel-past-report-end`、`18-wheel-past-end-fixed` |

### 發現並修正的問題

| # | 問題 | 根本原因 | 修正 commit |
|---|---|---|---|
| 1 | 呼叫 `ask_user` 後問題卡片下面又出現一段重述脈絡的話。 | Claude 照指示只思考、不寫字就結束這一輪，Claude Code 2.1.294 看到沒有文字的回覆會補一句 `[Your previous response had no visible output. Please continue and produce a user-visible response.]`。CLI 的程式碼裡，最後的工具結果來自 `CLAUDE_CODE_TERMINAL_MCP_TOOLS` 列出的工具時不補。啟動 CLI 時列出要求結束這一輪的四個 harness 工具。 | `81b4ff7` fix(main): stop Claude Code from nudging Claude to narrate after asking |
| 2 | 分岔裡呼叫 `conclude_branch` 後，Claude 在結論預覽上面把整個結論再寫一次。 | `conclude_branch` 的回傳文字只有「請結束這一輪」，「回覆的寫法」的不重述規則只涵蓋 `propose_spec`、`submit_report`。兩處都補上。修正後第一個分岔只剩一句「請在介面上確認，確認後就會帶回主線。」，第二個分岔沒有文字。 | `5c0c92f` fix(main): ask Claude not to restate the branch conclusion |
| 3 | 報告頁捲到底再滾，整個 app 捲出視窗只剩空白；跳到測試檔時標題列與側欄往上移 16px。 | 架構圖的 sr-only 連線清單是絕對定位、沒有定位祖先，停在報告欄深處的靜態位置，文件因此比視窗高（900px 視窗中 2248px），捲動串接與 `scrollIntoView` 都會捲動文件。app 外框改成 `relative overflow-clip`（`clip` 不是捲動容器，裁掉的內容不會讓文件變高）。修正後文件高度等於視窗高度，兩種操作都不會移動外框。 | `0b71d5e` fix(ui): keep the app shell from scrolling away |
| 4 | 分岔的回覆叫使用者「送出 [conclude]」。 | 提示把協定寫成「使用者送出 [conclude] 時…」，沒有說標記由介面送出、使用者看不到也不會自己輸入。「回覆的寫法」加一條：不要提到標記，需要使用者動作時指向介面上的按鈕。 | `1e9c117` fix(main): keep Harness message tags out of Claude's replies |

### 未解決／觀察

- `CLAUDE_CODE_TERMINAL_MCP_TOOLS` 只讓 Claude Code 不再催促，Claude 自己要寫字時仍會寫：修正後還看到 `propose_spec` 後「等你審閱。」、`conclude_branch` 後「請在介面上確認，確認後就會帶回主線。」；修正前 `propose_spec`、`submit_report` 後各有一段摘要（「規格草稿已經寫好了…另外有兩處是我自己的設計，請你確認是否接受」「鎖定功能已完成…有兩點需要你注意」，不是被催出來的）。要不要在介面上隱藏這些工具之後的文字是設計決定，這次沒有處理。
- 問題 4 的提示只用一個分岔驗證過（這個問題本來就不是每次都出現）。
- 修正前有一次 Claude 連續兩次用同樣參數呼叫 `ask_user`（時間軸多一筆 `question`，畫面只有一張卡片）；修正後沒有再出現。
- ~~被拒的工具呼叫（釐清時的 Bash）仍以紅色「工具錯誤」顯示~~ → 已修正：Harness 規則擋下的呼叫（PreToolUse hook 或 `canUseTool` 的 deny）由 TaskManager 標記，時間軸顯示中性的「已阻擋：原因」（不帶 SDK 的「PreToolUse:… hook error」前綴），實作的工具列表顯示「已阻擋」；真的失敗仍是紅色。`f39ae19` feat: show tool calls blocked by Harness rules as 已阻擋, not errors（以單元與元件測試驗證，下一次真實 Claude 驗證時確認畫面）
- 從訊息開的分岔標題截在 30 個字元，長的問題會斷在詞中間（「…每次失敗都重新」），Claude 帶回主線時會換掉。
- 報告的「修改」標籤這次沒有自然出現（Claude 沒有改既有測試）。

### 耗時

- 真實 Claude 執行時間約 5 分鐘（任務 1 約 3 分 15 秒：釐清 28 秒、分岔 15 秒、帶回 12 秒、重新提問 18 秒、規格 21 秒、實作到核准 22 秒、實作到報告 80 秒；任務 2 約 40 秒；任務 3 約 1 分 20 秒）。
- 實際經過時間約 40 分鐘（含查 CLI 原始碼、修正與重新建置）。

# Harness 設計文件

日期：2026-10-07
狀態：已核准（設計）
UI 設計：Claude Design 畫布 https://claude.ai/artifact/KuQ97AsXLopXpoUnQc3eG8（第二排「風格 B：完整流程畫面」為準）

## 1. 目標

個人用的 macOS 桌面 app。使用者選一個 repo，用聊天描述需求；Claude 透過結構化問題釐清方向與細節（可在卡片內反問、可分岔深入討論後帶回結論）；使用者核准規格後，Claude 在獨立 worktree 實作；完成後以 HTML 報告呈現架構、決策與原因、限制、程式碼變更與測試結果，使用者可在報告上回饋並迭代，最後開 PR、合併或丟棄。

非目標：多使用者、雲端同步、API key 計費、程式碼簽章與自動更新、i18n（介面固定繁體中文）。

## 2. 已確認的需求決策

| 項目 | 決定 |
|---|---|
| 使用範圍 | 只給自己用；透過本機已登入的 Claude Code（訂閱方案），不使用 API key |
| 技術堆疊 | Electron + React + TypeScript；主程序使用 `@anthropic-ai/claude-agent-sdk` |
| 分岔模型 | 側邊子討論，繼承主線上下文；「帶回主線」時產生結構化決策注入主線；只有一層 |
| 反問 | 問題卡片內就地反問，Claude 回答後可更新選項／建議；可「升級成分岔」 |
| 釐清流程 | 問題卡片（選項＋自由輸入）→ 規格草稿 → 使用者核准才實作 |
| 工作區 | 每個任務一個 git worktree＋新分支 |
| 工具權限 | worktree 內檔案讀寫自動允許；shell 指令需核准（可勾「本任務內都允許此指令」）；有全域永遠允許清單 |
| 實作中 | 顯示計畫步驟與工具呼叫細節；可插話、可停止；規格未涵蓋的問題以問題卡片暫停詢問 |
| 報告 | 固定骨架＋Claude 自由 HTML 區塊；包含架構前後對照、決策紀錄、限制／風險／後續、diff＋修改原因＋測試結果 |
| 報告之後 | 可對報告區塊／diff 行留回饋 → 產生 v2（保留版本）；收尾：開 PR／合併／丟棄 worktree |
| 資訊架構 | 左欄 repo → 任務，多任務可並行，永久保存 |
| Claude Code 設定 | 載入 repo 的 CLAUDE.md 與 `.claude`（`settingSources: ['project']`）；不載入使用者層級 hooks/plugins |
| 模型 | 預設 Opus 5.5（`claude-opus-5-5`），可在設定或每個任務改用 Sonnet 5.5（`claude-sonnet-5-5`） |
| 語言 | 介面、問題卡片、報告皆為繁體中文 |
| 視覺風格 | B「瓷白 Porcelain」：明亮、圓角卡片、主色青綠 `#0f766e`、Noto Sans TC＋IBM Plex Mono |
| 報告閱讀方式 | 單頁長捲動＋左側目錄 |
| 交付 | 完整功能，可用 `npm run dev` 在本機執行，並在示範 repo 跑完一輪驗證；不打包 |

## 3. 架構

```
Renderer (React, Vite)  ⇄  preload (contextBridge, typed IPC)  ⇄  Main (Node)
                                                                 ├─ TaskManager   任務狀態機與協調
                                                                 ├─ AgentRunner   包 Agent SDK query()，事件串流
                                                                 ├─ HarnessTools  in-process MCP server（自訂工具）
                                                                 ├─ PermissionGate canUseTool 實作（階段＋允許清單＋UI 核准）
                                                                 ├─ GitService    worktree / diff / commit / merge / gh pr
                                                                 ├─ VerifyRunner  在 worktree 實跑測試指令
                                                                 └─ Store         JSON 檔（app userData 目錄）
```

### 3.1 任務狀態機

```
clarifying ──propose_spec──▶ spec_review ──核准──▶ implementing ──submit_report──▶ reviewing
    ▲                            │ 要求修改                 ▲                         │ 送出回饋
    └────────────────────────────┘                          └─────────────────────────┘
reviewing ──開 PR / 合併──▶ done        任何狀態 ──丟棄──▶ discarded
```

- 建立任務時即建立 worktree（`<worktreeRoot>/<repo>/<slug>`，分支 `<prefix><slug>`，從使用者選的 base branch）。原因：Claude Code session 綁定工作目錄，全程使用同一 cwd 才能安全地 resume 與 fork。釐清階段仍為唯讀。
- 每個任務有一個主線 session（`mainSessionId`）與零到多個分岔 session。

### 3.2 Agent SDK 使用方式

所有 `query()` 呼叫共用：
- `cwd`: 任務 worktree
- `model`: 任務模型
- `settingSources: ['project']`
- `tools`: 只列出 PermissionGate 有規則的內建工具（Read、Glob、Grep、Edit、Write、NotebookEdit、Bash、WebFetch、WebSearch、子代理、ToolSearch）。新版 Claude Code 預設不提供 Glob／Grep（改用 Bash 搜尋），釐清階段不能用 Bash，必須明確列出
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: <Harness 階段指示> }`
- `mcpServers: { harness: HarnessTools }`（`alwaysLoad: true`：Claude Code 預設把 MCP 工具藏在 tool search 後面，沒先載入 schema 時 Claude 會猜錯參數）
- `canUseTool: PermissionGate`
- `pathToClaudeCodeExecutable`: 偵測到的本機 `claude`（沿用其訂閱登入）
- `env`: `process.env` 加上 `ENABLE_CLAUDEAI_MCP_SERVERS=false`（不載入 claude.ai 帳號上的連接器；PermissionGate 本來就會拒絕它們）
- `prompt`: AsyncIterable 佇列（串流輸入模式），以支援插話；停止用 `interrupt()`／`AbortController`
- 續接：`resume: sessionId`；分岔：`resume: mainSessionId, forkSession: true`

### 3.3 自訂工具（HarnessTools）

所有工具都是非阻塞：寫入 Store、推送 UI 事件後立即回傳。需要使用者回應的工具會在回傳文字中要求 Claude 結束這一輪。

| 工具 | 階段 | 作用 |
|---|---|---|
| `ask_user({question_id, question, options[{id,label,description}], recommended_option_id, allow_free_text, context})` | 釐清、實作 | 顯示／更新問題卡片（同一 `question_id` 再呼叫＝更新卡片） |
| `propose_spec({title, summary, in_scope[], out_of_scope[], decisions[{id,text,source}], steps[], acceptance[]})` | 釐清 | 產生／更新規格草稿，任務轉為 `spec_review` |
| `update_plan({steps[{id,title,status}]})` | 實作 | 更新步驟進度 |
| `conclude_branch({decision, rationale, deferred[]})` | 分岔 | 產生分岔結論 |
| `submit_report(ReportInput)` | 實作 | 提交報告結構化資料，任務轉為 `reviewing` |

使用者回應以結構化的 user message 送回主線，例如：
- `[answer question_id=q3 option=lock15] 備註…`
- `[counter_question question_id=q3] 鎖定期間輸入正確密碼要回什麼？`
- `[branch_conclusion branch=b2] 決策：…；原因：…；延後：…`
- `[spec_feedback] 上限改成 10 次`／`[spec_approved]`
- `[report_feedback anchor=diff:src/auth/lockout.ts:13] …`

階段指示（append 到 system prompt）定義這些格式與行為規則：釐清時一次只問一題、一定用 `ask_user`、收到反問要回答後用同一 `question_id` 重新呼叫 `ask_user`；有把握時呼叫 `propose_spec`；實作時依步驟呼叫 `update_plan`；完成時呼叫 `submit_report`。

### 3.4 權限（PermissionGate）

- 任何階段：`ToolSearch`（只載入工具 schema）、`TodoWrite`、子代理一律允許。
- 釐清／規格／分岔階段：允許 `Read`、`Glob`、`Grep`、harness 工具；其他一律 deny（附說明）。
- 實作階段：
  - `Read`/`Glob`/`Grep`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit`：路徑在 worktree 內自動允許，否則 deny。
  - `Bash`：符合全域永遠允許清單或本任務允許清單 → allow；否則推送核准請求到 UI，等待使用者「允許／拒絕並說明」，可勾選加入本任務允許清單（以指令前綴樣式比對，如 `npm test *`）。
  - `WebFetch`/`WebSearch`：需核准。
  - 其他：deny。
- 執行方式：規則集中在純函式 `evaluateTool`。硬性規則（deny／ask）由 **PreToolUse hook** 執行，因為 SDK 會先套用專案 `.claude/settings.json` 的 allow 規則才呼叫 `canUseTool`，只靠 `canUseTool` 會被繞過；`canUseTool` 負責核准流程（等待使用者、核准後再確認任務階段）。harness 工具只信任 `mcpServer.source === 'sdk'` 且名稱為 `harness` 的伺服器。
- 路徑：以 realpath 解開 symlink 後才比對 worktree；`~` 開頭、含 `..` 片段、非字串路徑、寫入工具缺路徑一律 deny；Glob pattern 含 `..`，或在開頭／大括號選項中以 `/`、`~` 起頭也 deny。寫入 `.git`、`.claude/`、`.mcp.json` 即使在實作階段也要核准。

### 3.5 分岔

1. 使用者在主線任一 Claude 訊息或問題卡片點「分岔」（或卡片「升級成分岔」，會把卡片內的反問一併帶入開場訊息）。
2. `query({ resume: mainSessionId, forkSession: true, prompt: <分岔開場> })`，得到分岔 session id。分岔唯讀。
3. 「帶回主線」：對分岔送 `[conclude]`，Claude 呼叫 `conclude_branch`；使用者在預覽中確認後，app 將 `[branch_conclusion …]` 送入主線，並在主線顯示「◆ 決策」訊息。
4. 分岔進行時主線可繼續；分岔只開一層。

### 3.6 報告

`ReportInput`（zod 驗證）：
- `overview: { headline, summary }`
- `tests[{ id, file, name, kind:'unit'|'integration'|'e2e'|'other', change:'added'|'modified', scenario, why?, line? }]`、`tests_note?`：本次新增或修改的每個測試與情境（白話：在什麼情況下 → 做什麼 → 預期什麼），修改既有測試時 `why` 說明原因；沒有新增測試時留空並以 `tests_note` 說明原因。報告最優先呈現這一段（2026-10-08 使用者要求）。沒有這些欄位的舊報告照樣解析，讀取時補 `tests: []`。
- `architecture: { before: Graph, after: Graph }`，`Graph = { nodes[{id,label,status:'added'|'modified'|'unchanged',files[]}], edges[{from,to,label?}] }`
- `decisions[{ id, title, chosen, rejected[], rationale, source: {type:'question'|'branch'|'implementation', ref} }]`
- `limitations[{ title, detail, severity }]`、`followups[{ title, detail }]`
- `file_notes[{ path, hunks?: [{ line_start, line_end, why }], why }]`
- `verification[{ command }]`
- `custom_blocks[{ id, title, html }]`

由 app 產生、不依賴 Claude 自述：
- diff：`git diff <base>...HEAD`（提交報告時 app 先 commit worktree 變更）
- 統計：檔案數、增刪行數
- 測試結果：VerifyRunner 在 worktree 內依序實跑 `verification` 指令（只跑本任務已核准過或在允許清單中的指令），記錄 exit code、輸出摘要與耗時
- 測試檔偵測：依路徑（`*.test.*`、`*.spec.*`、`*_test.*`、`test_*.py`，或在 `tests/`、`test/`、`__tests__/`、`spec/` 底下）從 diff 找出測試檔；Claude 沒在 `tests` 說明的標「未說明」

呈現：
- Renderer 用 React 元件渲染固定骨架，順序：概觀（變更檔案、行數、新增測試、驗證、決策五格數據）→ 新增的測試 → 架構前後對照 → 決策 → 自訂區塊 → 限制與後續 → 程式碼變更 → 測試結果；架構圖以前後兩欄自動分層排版。
- 「新增的測試」：每個測試列出名稱、檔案、類型、新增／修改、情境、修改原因與驗證結果。驗證結果不捏造逐個測試的結果：輸出提到該測試檔的指令顯示該指令的結果，只有一個驗證指令時顯示它的結果，否則顯示整體的「x / y 通過」並連到測試結果。點測試跳到 diff 中的測試檔（有行號時到那一行）。沒有新增測試時以提醒樣式顯示「這次沒有新增測試」與原因（diff 裡其實有新的測試檔時改說「Claude 沒有說明新增的測試」）；未說明的測試檔列在區塊最後。
- `custom_blocks` 以 `<iframe sandbox="allow-scripts" srcdoc>` 呈現，附 CSP（禁止網路），不給 same-origin。
- 回饋錨點：區塊（`section:<id>`，新增的測試為 `section:tests`）、測試（`test:<id>`）、決策（`decision:<id>`）、自訂區塊（`block:<id>`）、整個檔案（`file:<path>`）、diff 行（`diff:<path>:<line>`）。送出回饋 → 任務回到 `implementing`，完成後產生 v2；舊版本保留可切換。
- 匯出 HTML：產生單一自含 HTML 檔（含靜態的「新增的測試」）。

### 3.7 收尾

- 開 PR：`git push -u origin <branch>` 後 `gh pr create`（標題＝規格標題，內文＝報告摘要、新增的測試與情境、決策、限制、後續工作與驗證結果）。
- 合併：在原 repo 檢查工作目錄乾淨且位於 base branch，`git merge --no-ff <branch>`；失敗（衝突／不乾淨）顯示原因並中止。
- 丟棄：`git worktree remove --force` ＋刪除分支（需確認）。

### 3.8 儲存

`app.getPath('userData')/harness/`：
- `settings.json`
- `repos.json`
- `tasks/<taskId>/task.json`（狀態、session ids、問題卡片、決策、規格版本、計畫、允許清單）
- `tasks/<taskId>/timeline.jsonl`（主線與分岔的訊息／事件，供 UI 重建）
- `tasks/<taskId>/reports/v<n>.json`

寫入使用暫存檔再 rename 確保原子性。app 重啟後，執行中的任務標為「已中斷」，使用者可「繼續」（以 `resume` 重新啟動）。

## 4. UI 畫面（對應設計畫布）

1. 新任務：選 repo／加入資料夾、需求、base branch、模型
2. 釐清對話：主線訊息、已答問題摘要列、決策訊息、問題卡片（選項、反問串、升級分岔、確認答案）、右側分岔面板
3. 規格核准：規格草稿、決策來源標籤、要求修改／核准；右側釐清紀錄
4. 實作進度：進度條、步驟清單、工具呼叫明細、插話與停止、指令核准對話框；右側變更檔案、允許清單、worktree
5. 變更報告：概觀數據、架構前後、決策卡、自訂視覺化區塊、限制與後續、diff＋為什麼、測試結果；右側回饋彙整與收尾按鈕
6. 設定：Claude Code 偵測與登入狀態、預設模型、權限與允許清單、worktree 位置與分支前綴、載入專案設定

## 5. 錯誤處理

- 找不到 `claude` 或未登入：設定頁與新任務頁顯示說明（請在終端機執行 `claude` 登入），停用開始按鈕。
- 訂閱額度用盡／rate limit：顯示 SDK 回報的限制資訊，任務標為「暫停」，可稍後繼續。
- SDK 程序崩潰或中斷：任務標為「已中斷」，保留 session id，可繼續。
- Claude 未依格式呼叫工具（例如釐清時直接用文字提問）：照常顯示文字訊息，使用者仍可在輸入框回覆。
- `submit_report` 驗證失敗：把 zod 錯誤回給 Claude 要求修正。
- Git 操作失敗：顯示指令與 stderr，不自動重試。

## 6. 測試策略

- 單元（Vitest）：狀態機轉換、PermissionGate 決策表、指令樣式比對、HarnessTools handler、ReportInput schema、結構化訊息格式化／解析、Store 原子寫入。
- 整合（Vitest，暫存 git repo）：GitService 的 worktree 建立／diff／commit／merge／丟棄、VerifyRunner。
- AgentRunner 以介面隔離，測試使用假的 SDK 事件串流驅動 TaskManager 全流程（釐清 → 規格 → 實作 → 報告 → 回饋 → v2）。
- 元件（React Testing Library）：問題卡片（選擇、反問、升級分岔）、分岔面板、指令核准對話框、報告回饋錨點。
- 端對端手動驗證：在示範 repo 用真實 Claude 跑完整一輪。

## 7. 專案結構

```
my_harness/
  package.json  electron.vite.config.ts  tsconfig*.json
  src/
    shared/      型別、IPC 契約、ReportInput schema、訊息格式
    main/        index.ts、tasks/、agent/、tools/、permissions/、git/、verify/、store/
    preload/     index.ts
    renderer/    App.tsx、screens/、components/、styles/（B 風格 tokens）
  tests/         與 src 對應
  docs/plans/
```

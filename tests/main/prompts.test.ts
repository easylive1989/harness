import { expect, test } from 'vitest'
import { MAIN_SYSTEM_APPEND } from '../../src/main/agent/prompts'

test('提示涵蓋所有工具與訊息格式', () => {
  for (const s of [
    'mcp__harness__ask_user',
    'mcp__harness__propose_spec',
    'mcp__harness__update_plan',
    'mcp__harness__submit_report',
    '[answer',
    '[counter_question',
    '[branch_conclusion',
    '[spec_approved]',
    '[spec_feedback',
    '[report_feedback',
    '[resume]',
    '[branch_open]',
    '[conclude]',
    'conclude_branch',
    'diff:檔案路徑:行號',
    'file:檔案路徑',
    'test:測試 id',
    'section:tests',
    'tests：最優先',
    // 測試說明分成情境（given）與預期行為（then）；單元測試照樣列出但不顯示
    'scenario（情境',
    'given／arrange',
    'expected（預期行為',
    'then／assert',
    'name、kind、change、scenario、expected 的寫法',
    '不會顯示 kind=unit 的測試',
    'tests_note',
    '只有在沒有新增也沒有修改任何測試時 tests 才留空',
    '修改的測試仍要列出',
    '高度由內容決定，不要使用 vh 或 100% 高度',
    '繁體中文',
    // 使用者在規格回饋、插話、報告回饋中直接給的指示造成的決策
    '{type:"user"',
    '你的指示'
  ]) {
    expect(MAIN_SYSTEM_APPEND).toContain(s)
  }
})

test('Claude 的文字：過場句也用繁體中文；提問、提出規格、帶回分岔結論與報告時不在文字中重述內容', () => {
  for (const s of [
    '包含簡短說明與過渡語句',
    '只有程式碼、識別字、指令、檔案路徑與錯誤訊息保留原文',
    '問題、選項與取捨只放在工具參數裡',
    '不要在文字中重述問題或選項',
    '「我已在介面上送出問題」',
    '只寫與問題不重複的脈絡（1–2 句）',
    '呼叫 propose_spec、conclude_branch、submit_report 前後同理',
    // 標記是介面送的：Claude 不要叫使用者「送出 [conclude]」，改指向介面上的按鈕
    '使用者看不到也不會自己輸入這些標記',
    '「帶回主線」',
    '不要在文字中重述規格、結論或報告的內容'
  ]) {
    expect(MAIN_SYSTEM_APPEND).toContain(s)
  }
})

test('回答反問時可以引用選項：這不算重述（反問的回答寫進卡片裡）', () => {
  const rule = MAIN_SYSTEM_APPEND.split('\n').find((l) =>
    l.includes('[counter_question question_id=…]')
  )
  expect(rule).toContain('回答反問時可以引用選項，這不算重述')
  // 只有文字回覆會顯示在使用者的反問下面：回答只放在 context 時，使用者看起來像沒有得到回覆
  expect(rule).toContain('一定要先輸出文字回答')
  expect(rule).toContain('不要只把回答寫進 ask_user 的 context')
})

test('規格列出預計測試（沒有時說明原因），報告的測試對應回規格，沒做到的說明原因', () => {
  const lines = MAIN_SYSTEM_APPEND.split('\n')
  const spec = lines.find((l) => l.includes('propose_spec 的 tests'))
  expect(spec).toContain('id 用 p1、p2…')
  expect(spec).toContain('tests 留空，並在 tests_note 說明原因')
  const report = lines.find((l) => l.includes('planned_skipped'))
  expect(report).toContain('planned 填這個測試對應的規格預計測試 id')
  expect(report).toContain('每個預計測試都要有對應的測試，或列在 planned_skipped')
})

test('測試的分類（kind）有判斷標準，規格與報告共用', () => {
  for (const s of [
    '### 測試的分類（kind）',
    '- unit：只測一個函式或模組',
    '- integration：',
    '- e2e：',
    '- other：'
  ])
    expect(MAIN_SYSTEM_APPEND).toContain(s)
})

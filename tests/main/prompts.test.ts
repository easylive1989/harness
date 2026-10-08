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
    '在什麼情況下 → 做什麼 → 預期什麼',
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

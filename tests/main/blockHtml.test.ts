// tests/main/blockHtml.test.ts
import { expect, test } from 'vitest'
import { BLOCK_CSP, parseBlockUrl, wrapBlockHtml } from '../../src/main/report/blockHtml'

test('包住區塊 HTML 並回報高度', () => {
  const html = wrapBlockHtml({ id: 'state-machine', title: 't', html: '<div id="x">hi</div>' })
  expect(html).toContain('<div id="x">hi</div>')
  expect(html).toContain('"harness-block-height"')
  expect(html).toContain('"state-machine"')
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain(`content="${BLOCK_CSP}"`)
})

test('id 裡的 < 不會結束 script', () => {
  const html = wrapBlockHtml({ id: '</script>', title: 't', html: '' })
  expect(html).not.toContain('"</script>"')
})

test('CSP 禁止網路', () => {
  expect(BLOCK_CSP).toContain("default-src 'none'")
  expect(BLOCK_CSP).not.toContain('http')
})

test('解析區塊網址', () => {
  expect(parseBlockUrl('harness-block://report/ab12cd34/2/state-machine')).toEqual({
    taskId: 'ab12cd34',
    version: 2,
    blockId: 'state-machine'
  })
})

test.each([
  'harness-block://report/ab12/0/x',
  'harness-block://report/ab12/1.5/x',
  'harness-block://report/ab12/-1/x',
  'harness-block://report/ab12/abc/x',
  'harness-block://report/..%2f..%2fetc/1/x',
  'harness-block://report/ab12/1/..',
  'harness-block://report/ab12/1/X%20Y',
  'harness-block://report/ab12/1',
  'harness-block://report/ab12/1/x/extra',
  'harness-block://other/ab12/1/x',
  'https://report/ab12/1/x',
  'not a url'
])('拒絕不合格式的網址 %s', (url) => {
  expect(parseBlockUrl(url)).toBeNull()
})

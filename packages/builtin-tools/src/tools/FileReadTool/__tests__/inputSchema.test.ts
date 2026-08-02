import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool'

function parseReadInput(pages?: string) {
  const input =
    pages === undefined
      ? { file_path: '/tmp/example.txt' }
      : { file_path: '/tmp/example.txt', pages }
  const result = FileReadTool.inputSchema.safeParse(input)

  expect(result.success).toBe(true)
  if (!result.success) {
    throw result.error
  }

  return result.data
}

describe('FileReadTool input schema', () => {
  test('treats empty optional PDF page ranges as omitted', () => {
    expect(parseReadInput('').pages).toBeUndefined()
    expect(parseReadInput('   ').pages).toBeUndefined()
  })

  test('keeps omitted and valid PDF page ranges unchanged', () => {
    expect(parseReadInput().pages).toBeUndefined()
    expect(parseReadInput('1-5').pages).toBe('1-5')
  })

  test('keeps non-empty invalid ranges for validateInput to reject', () => {
    expect(parseReadInput('invalid').pages).toBe('invalid')
  })
})

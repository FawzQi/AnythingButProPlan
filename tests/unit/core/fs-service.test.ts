import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  readTextFile,
  resolveWithinRoot,
  MAX_TEXT_FILE_BYTES,
} from '../../../src/main/services/core/fs-service'

describe('fs-service: readTextFile', () => {
  it('exports MAX_TEXT_FILE_BYTES set to 5 MB', () => {
    expect(MAX_TEXT_FILE_BYTES).toBe(5 * 1024 * 1024)
  })

  it('reads a text file within the size limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-test-'))
    try {
      const filePath = path.join(tempDir, 'hello.txt')
      await fs.writeFile(filePath, 'hello world', 'utf8')

      const content = await readTextFile(tempDir, 'hello.txt')
      expect(content).toBe('hello world')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('throws an error when file exceeds maxBytes limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-test-'))
    try {
      const filePath = path.join(tempDir, 'large.txt')
      // Write 200 bytes
      await fs.writeFile(filePath, 'a'.repeat(200), 'utf8')

      // Set maxBytes limit to 100 bytes
      await expect(readTextFile(tempDir, 'large.txt', 100)).rejects.toThrow(
        /is too large/,
      )
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('fs-service: resolveWithinRoot', () => {
  it('resolves valid relative paths with forward slashes and backslashes', () => {
    const root = '/mock/project/root'
    expect(resolveWithinRoot(root, 'src/index.ts')).toBe(
      path.resolve(root, 'src/index.ts'),
    )
    expect(resolveWithinRoot(root, 'src\\nested\\file.ts')).toBe(
      path.resolve(root, 'src/nested/file.ts'),
    )
  })

  it('rejects path traversal attempting to escape project root', () => {
    const root = '/mock/project/root'
    expect(() => resolveWithinRoot(root, '../outside.txt')).toThrow(
      /Path escapes the project root/,
    )
    expect(() => resolveWithinRoot(root, 'foo\\..\\..\\outside.txt')).toThrow(
      /Path escapes the project root/,
    )
  })

  it('rejects reserved device names and invalid filenames across path formats', () => {
    const root = '/mock/project/root'
    expect(() => resolveWithinRoot(root, 'src/CON/file.txt')).toThrow(
      /Path is not portable across platforms/,
    )
    expect(() => resolveWithinRoot(root, 'src\\NUL.txt')).toThrow(
      /Path is not portable across platforms/,
    )
    expect(() => resolveWithinRoot(root, 'src/aux')).toThrow(
      /Path is not portable across platforms/,
    )
  })
})

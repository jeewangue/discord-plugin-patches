import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from './file-lock.ts'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flk-'))
  lockPath = join(dir, 'test.lock')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('withFileLock', () => {
  test('runs fn and releases lock', async () => {
    const result = await withFileLock(lockPath, async () => 42)
    expect(result).toBe(42)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('serializes overlapping calls in the same process', async () => {
    const log: string[] = []
    const job = (id: string, hold: number) =>
      withFileLock(lockPath, async () => {
        log.push(`enter ${id}`)
        await new Promise(r => setTimeout(r, hold))
        log.push(`exit ${id}`)
      })
    await Promise.all([job('A', 80), job('B', 30), job('C', 30)])
    // Whatever the order, exits must immediately follow enters (no
    // interleaving of "enter A enter B").
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]?.startsWith('enter')).toBe(true)
      expect(log[i + 1]?.startsWith('exit')).toBe(true)
      const id = log[i]!.split(' ')[1]
      expect(log[i + 1]).toBe(`exit ${id}`)
    }
  })

  test('cleans up lockfile if fn throws', async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('steals stale lock', async () => {
    // Drop a fake stale lockfile aged past the threshold.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, t: 0 }))
    // Bump mtime backwards.
    const past = new Date(Date.now() - 60_000)
    require('node:fs').utimesSync(lockPath, past, past)
    const result = await withFileLock(
      lockPath,
      async () => 'stolen',
      { staleMs: 1_000, timeoutMs: 2_000 },
    )
    expect(result).toBe('stolen')
  })

  test('throws on timeout when lock held longer', async () => {
    const slow = withFileLock(lockPath, async () => {
      await new Promise(r => setTimeout(r, 500))
      return 'done'
    })
    // Tiny timeout so we don't actually wait long.
    await expect(
      withFileLock(lockPath, async () => 'never', { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/)
    await slow
  })
})

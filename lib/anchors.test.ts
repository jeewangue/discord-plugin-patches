import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commitThreadRecord,
  readAnchors,
  saveAnchors,
  withAnchorLock,
  type AnchorState,
} from './anchors.ts'

let stateDir: string
let stateFile: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'anch-'))
  stateFile = join(stateDir, 'anchors.json')
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('readAnchors / saveAnchors', () => {
  test('readAnchors on missing file returns {}', () => {
    expect(readAnchors(stateFile)).toEqual({})
  })

  test('saveAnchors round-trips state', () => {
    const state: AnchorState = {
      'thread-1': { sections: [{ messageIds: ['a', 'b'] }] },
    }
    saveAnchors(stateFile, state)
    expect(readAnchors(stateFile)).toEqual(state)
  })

  test('saveAnchors uses unique tmp file (no shared .tmp clobber)', async () => {
    // Run two saves concurrently; both should succeed with the LATER one
    // visible (atomic rename). The intermediate tmp files should not collide.
    await Promise.all([
      Promise.resolve().then(() =>
        saveAnchors(stateFile, { a: { sections: [{ messageIds: ['1'] }] } }),
      ),
      Promise.resolve().then(() =>
        saveAnchors(stateFile, { b: { sections: [{ messageIds: ['2'] }] } }),
      ),
    ])
    const final = readAnchors(stateFile)
    // One of the two must have ended up on disk; the file must be parseable.
    const keys = Object.keys(final)
    expect(keys.length).toBe(1)
    expect(['a', 'b']).toContain(keys[0]!)
  })

  test('readAnchors swallows malformed JSON and returns {}', () => {
    require('node:fs').writeFileSync(stateFile, '{not json')
    expect(readAnchors(stateFile)).toEqual({})
  })
})

describe('commitThreadRecord', () => {
  test('inserts a new record', async () => {
    await commitThreadRecord(
      { stateDir },
      stateFile,
      'thread-1',
      { sections: [{ messageIds: ['m1'] }] },
    )
    expect(readAnchors(stateFile)).toEqual({
      'thread-1': { sections: [{ messageIds: ['m1'] }] },
    })
  })

  test('removes a record when next is null', async () => {
    saveAnchors(stateFile, {
      'thread-1': { sections: [{ messageIds: ['m1'] }] },
      'thread-2': { sections: [{ messageIds: ['m2'] }] },
    })
    await commitThreadRecord({ stateDir }, stateFile, 'thread-1', null)
    expect(readAnchors(stateFile)).toEqual({
      'thread-2': { sections: [{ messageIds: ['m2'] }] },
    })
  })

  test('preserves other threads through the read-modify-write window', async () => {
    saveAnchors(stateFile, {
      'thread-A': { sections: [{ messageIds: ['a1'] }] },
    })
    // Commit on thread-B happens after seeding thread-A; the result must
    // contain BOTH because commit re-reads inside the lock.
    await commitThreadRecord(
      { stateDir },
      stateFile,
      'thread-B',
      { sections: [{ messageIds: ['b1'] }] },
    )
    expect(readAnchors(stateFile)).toEqual({
      'thread-A': { sections: [{ messageIds: ['a1'] }] },
      'thread-B': { sections: [{ messageIds: ['b1'] }] },
    })
  })
})

describe('withAnchorLock concurrency', () => {
  test('per-thread keys do not block each other', async () => {
    const t0 = Date.now()
    await Promise.all([
      withAnchorLock({ stateDir }, 'anchor-t1', async () => {
        await new Promise(r => setTimeout(r, 100))
      }),
      withAnchorLock({ stateDir }, 'anchor-t2', async () => {
        await new Promise(r => setTimeout(r, 100))
      }),
    ])
    const elapsed = Date.now() - t0
    // Should run in parallel (~100ms), not serialized (~200ms).
    expect(elapsed).toBeLessThan(180)
  })

  test('same-key holders serialize', async () => {
    const log: string[] = []
    await Promise.all([
      withAnchorLock({ stateDir }, 'anchor-shared', async () => {
        log.push('A enter')
        await new Promise(r => setTimeout(r, 80))
        log.push('A exit')
      }),
      withAnchorLock({ stateDir }, 'anchor-shared', async () => {
        log.push('B enter')
        await new Promise(r => setTimeout(r, 80))
        log.push('B exit')
      }),
    ])
    // No interleaving: every "exit" follows immediately after the matching
    // "enter".
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i + 1]).toBe(log[i]!.replace('enter', 'exit'))
    }
  })

  test('two parallel commits on different threads end with both records', async () => {
    await Promise.all([
      (async () => {
        await withAnchorLock({ stateDir }, 'anchor-t1', async () => {
          await commitThreadRecord(
            { stateDir },
            stateFile,
            't1',
            { sections: [{ messageIds: ['1'] }] },
          )
        })
      })(),
      (async () => {
        await withAnchorLock({ stateDir }, 'anchor-t2', async () => {
          await commitThreadRecord(
            { stateDir },
            stateFile,
            't2',
            { sections: [{ messageIds: ['2'] }] },
          )
        })
      })(),
    ])
    const final = readAnchors(stateFile)
    expect(Object.keys(final).sort()).toEqual(['t1', 't2'])
  })

  test('lock files are cleaned up between successful runs', async () => {
    await withAnchorLock({ stateDir }, 'anchor-t1', async () => undefined)
    const lockPath = join(stateDir, 'locks', 'anchor-t1.lock')
    expect(existsSync(lockPath)).toBe(false)
  })
})

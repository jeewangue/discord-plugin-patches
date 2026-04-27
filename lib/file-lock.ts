// Cooperative file lock for cross-process state coordination.
//
// Used to serialize anchors.json read-modify-write across multiple Claude Code
// processes (and concurrent in-process agents). Uses fs.openSync(..., 'wx')
// for atomic exclusive creation, and a heartbeat-touched mtime so a crashed
// holder doesn't strand the lock forever.

import { closeSync, openSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'

export type FileLockOptions = {
  /** Treat lock files older than this (ms) as stale and steal them. Default 30s. */
  staleMs?: number
  /** Max time to wait for a busy lock before throwing (ms). Default 15s. */
  timeoutMs?: number
  /** Touch interval for the heartbeat (ms). Default 5s. 0 disables. */
  heartbeatMs?: number
  /** Initial retry delay in ms (jittered). Default 50. */
  baseRetryMs?: number
  /** Max retry delay in ms. Default 500. */
  maxRetryMs?: number
}

// Invariant: timeoutMs < staleMs. If we ever wait longer than staleMs without
// acquiring, another waiter could simultaneously decide our (live) lock is
// stale and steal it — split-brain the holder. Keep timeoutMs ≤ staleMs / 2.
const DEFAULTS: Required<FileLockOptions> = {
  staleMs: 30_000,
  timeoutMs: 15_000,
  heartbeatMs: 5_000,
  baseRetryMs: 50,
  maxRetryMs: 500,
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }))
    closeSync(fd)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw err
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    const st = statSync(lockPath)
    return Date.now() - st.mtimeMs > staleMs
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Acquire a file lock, run the function, release the lock. Cleans up the
 * lockfile even if the function throws. Heartbeats touch the mtime while the
 * function is running so other waiters see we're alive.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const cfg = { ...DEFAULTS, ...opts }
  const start = Date.now()
  let attempt = 0

  while (true) {
    if (tryAcquire(lockPath)) break
    if (isStale(lockPath, cfg.staleMs)) {
      try {
        unlinkSync(lockPath)
      } catch {}
      continue
    }
    if (Date.now() - start > cfg.timeoutMs) {
      throw new Error(
        `file lock at ${lockPath} timed out after ${cfg.timeoutMs}ms — another holder still alive`,
      )
    }
    const delay = Math.min(
      cfg.maxRetryMs,
      cfg.baseRetryMs * Math.pow(1.4, attempt),
    )
    await sleep(delay * (0.5 + Math.random()))
    attempt++
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined
  if (cfg.heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      try {
        const now = new Date()
        utimesSync(lockPath, now, now)
      } catch {}
    }, cfg.heartbeatMs)
    // Don't keep the event loop alive just for the heartbeat.
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
  }

  try {
    return await fn()
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    try {
      unlinkSync(lockPath)
    } catch {}
  }
}

// Persistent state for thread anchors. State file is keyed by thread ID and
// holds, per section, the ordered list of Discord message IDs that make up the
// section's chunked content.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withFileLock } from './file-lock.ts'

/**
 * One message that backs a chunk of a section. `preview` is an optional
 * human-readable hint (first line, label, …) so anchor_get output identifies
 * the message without re-fetching from Discord. `pinned` records the last
 * pin state we successfully applied — kept so the next set call can detect
 * a transition (pin true → false) and unpin instead of leaving the pin stuck.
 */
export type AnchorMessage = { id: string; preview?: string; pinned?: boolean }

/**
 * One section of a living thread. `title` is required for new writes —
 * legacy data without it still reads cleanly so we never lose anchored
 * messages mid-migration. `messageIds` is the canonical wire format
 * (kept for backwards compat); `messages` is the richer parallel form
 * that, when present, MUST agree on the id list.
 */
export type AnchorSection = {
  messageIds: string[]
  /** New (>= rich-anchor): human label for the section. */
  title?: string
  /** New: per-chunk preview / pin metadata. Same length + ids as messageIds when present. */
  messages?: AnchorMessage[]
}

export type AnchorParent = {
  id: string
  /** Optional — channel name for parent-of-thread. Not needed for top-level channels. */
  name?: string
}

export type AnchorThread = {
  sections: AnchorSection[]
  /** New: human-readable label for the thread/channel. Required on writes. */
  name?: string
  /** New: helps the model decide whether `parent` should be filled in. */
  kind?: 'channel' | 'thread'
  /** New: parent channel info (only for threads). */
  parent?: AnchorParent
}

export type AnchorState = Record<string, AnchorThread>

/**
 * Normalize a section so callers get both legacy `messageIds` and rich
 * `messages` invariants without having to handle all the migration shapes.
 * If `messages` is provided it wins; otherwise we synthesise it from `messageIds`.
 * Tolerates partial/corrupt records (either field undefined) without crashing —
 * pre-overhaul writes occasionally produced `{messageIds: undefined}`.
 */
export function normalizeSection(s: AnchorSection): {
  messageIds: string[]
  messages: AnchorMessage[]
  title?: string
} {
  if (Array.isArray(s.messages) && s.messages.length > 0) {
    return {
      messageIds: s.messages.map(m => m.id),
      messages: s.messages,
      title: s.title,
    }
  }
  const ids = Array.isArray(s.messageIds) ? s.messageIds : []
  return {
    messageIds: ids,
    messages: ids.map(id => ({ id })),
    title: s.title,
  }
}

export function readAnchors(file: string): AnchorState {
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AnchorState
    }
  } catch {}
  return {}
}

export function saveAnchors(file: string, state: AnchorState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Unique tmp per process+time so concurrent writers don't clobber the same
  // staging path. Defense-in-depth on top of the file lock.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

function lockKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

export type AnchorLockOptions = {
  stateDir: string
  staleMs?: number
  timeoutMs?: number
  heartbeatMs?: number
}

/**
 * Hold an exclusive lock for `key` (typically `anchor-<thread_id>` or `state`)
 * across the entire `fn` execution. Other invocations using the same key wait
 * up to `timeoutMs`.
 */
export async function withAnchorLock<T>(
  opts: AnchorLockOptions,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(opts.stateDir, 'locks')
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  const lockPath = join(lockDir, `${lockKey(key)}.lock`)
  return withFileLock(lockPath, fn, {
    staleMs: opts.staleMs,
    timeoutMs: opts.timeoutMs,
    heartbeatMs: opts.heartbeatMs,
  })
}

/**
 * Read-modify-write a single thread's record, with a brief lock on the global
 * state file held only across the read+write. Use after Discord ops have
 * completed (those should be inside withAnchorLock for the per-thread key).
 */
export async function commitThreadRecord(
  opts: AnchorLockOptions,
  file: string,
  thread_id: string,
  next: AnchorThread | null,
): Promise<void> {
  await withAnchorLock(opts, 'state', async () => {
    const fresh = readAnchors(file)
    if (next === null) {
      delete fresh[thread_id]
    } else {
      fresh[thread_id] = next
    }
    saveAnchors(file, fresh)
  })
}

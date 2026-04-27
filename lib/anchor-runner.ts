// Pure logic for the todo_anchor_set / todo_anchor_clear handlers, decoupled
// from discord.js so it can be exercised against a mock channel in tests.

import { normalizeSection, type AnchorSection, type AnchorThread } from './anchors.ts'

export interface MessageLike {
  readonly id: string
  readonly content: string
  edit(text: string): Promise<MessageLike>
  delete(): Promise<unknown>
  pin?: () => Promise<unknown>
  unpin?: () => Promise<unknown>
}

export interface ChannelLike {
  send(opts: { content: string }): Promise<{ id: string }>
  messages: {
    fetch(id: string): Promise<MessageLike>
  }
}

/**
 * Per-section input for anchor_set. Replaces the legacy `string` form so
 * callers must declare a title (= what the section is) and may declare
 * per-chunk hints (preview text, pin flag).
 */
export type SectionInput = {
  title: string
  body: string
  /** Optional: per-chunk metadata. Index 0 maps to the first chunk after
   *  newline-aware splitting; if shorter than the chunk count we degrade
   *  gracefully (extra chunks get no preview / no pin). */
  messages?: Array<{ preview?: string; pin?: boolean }>
}

export type AnchorRunResult = {
  next: AnchorThread
  edited: number
  created: number
  deleted: number
  /** Number of pin/unpin operations that succeeded this run. */
  pinned: number
  /** Number of pin/unpin operations that threw (Discord pin cap, perms, etc). */
  pinFailed: number
  /** Message IDs that we created (or kept) during this run, in order. Used by
   *  the caller for noteSent / mention tracking. */
  newSentIds: string[]
}

export type AnchorRunHooks = {
  /** Called every time we send a fresh message. Lets the host plumb the id
   *  into recent-sent tracking for mention detection. */
  onSent?: (id: string) => void
  /** Called when a `pin: true` flag could not be honored (REST failure,
   *  pin cap exceeded). Non-fatal — caller may emit a tracing log. */
  onPinError?: (id: string, err: unknown) => void
}

/** Stand-in payload Discord accepts when an "empty" section is desired — Discord
 *  rejects content === '' on send/edit, so substitute. */
const EMPTY_SECTION_PLACEHOLDER = '_(empty section)_'

/**
 * Run the anchor-set workflow against `prev` state and `sections` input.
 *
 * Edits in place where slots already exist, sends new chunks where they don't,
 * deletes surplus messages, and returns the new state. Callers MUST persist
 * `result.next` to anchors.json — even on partial failure, this function
 * raises with the work-so-far attached to the error so callers can durably
 * record progress before re-throwing.
 */
export async function runAnchorSet(
  ch: ChannelLike,
  prev: AnchorSection[],
  sections: SectionInput[],
  chunkBody: (body: string) => string[],
  hooks: AnchorRunHooks = {},
): Promise<AnchorRunResult> {
  const nextSections: AnchorSection[] = []
  const newSentIds: string[] = []
  let edited = 0
  let created = 0
  let deleted = 0
  let pinned = 0
  let pinFailed = 0

  /** Carry an un-iterated `prev[k]` forward verbatim — but route through
   *  normalizeSection so legacy `{messageIds-only}` records emerge with both
   *  shapes populated. The on-disk record must never have messages length
   *  diverge from messageIds. */
  const carryPrev = (k: number): AnchorSection | undefined => {
    const carry = prev[k]
    if (!carry) return undefined
    const norm = normalizeSection(carry)
    return {
      messageIds: [...norm.messageIds],
      title: norm.title,
      messages: norm.messages.map(m => ({ ...m })),
    }
  }

  const fail = (err: unknown): never => {
    const e = err instanceof Error ? err : new Error(String(err))
    ;(e as Error & { partial?: AnchorRunResult }).partial = {
      next: { sections: nextSections },
      edited,
      created,
      deleted,
      pinned,
      pinFailed,
      newSentIds,
    }
    throw e
  }

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!
    const body = sec.body ?? ''
    const chunks =
      body.length === 0 ? [EMPTY_SECTION_PLACEHOLDER] : chunkBody(body)
    const prevSec = prev[i] ? normalizeSection(prev[i]!) : undefined
    const existingIds = prevSec?.messageIds ?? []
    const existingMessages = prevSec?.messages ?? []
    const newIds: string[] = []
    /** Per-chunk pin state we successfully applied — written into the next
     *  section's messages[] so the next run can detect transitions. */
    const newPinState: boolean[] = []

    for (let j = 0; j < chunks.length; j++) {
      const content = chunks[j] ?? EMPTY_SECTION_PLACEHOLDER
      const id = existingIds[j]
      const hint = sec.messages?.[j]
      const desiredPin = hint?.pin === true
      const wasPinned = existingMessages[j]?.pinned === true
      let landedId: string | undefined
      let isReused = false

      if (id) {
        try {
          const existing = await ch.messages.fetch(id)
          if (existing.content !== content) {
            await existing.edit(content)
            edited++
          }
          newIds.push(id)
          newSentIds.push(id)
          landedId = id
          isReused = true
        } catch {
          // Message was deleted manually — fall through to re-send.
        }
      }

      if (!landedId) {
        let sent: { id: string }
        try {
          sent = await ch.send({ content })
        } catch (err) {
          // Preserve the not-yet-iterated tail of `prev` so a retry can still
          // see and reconcile those slots — otherwise their messages leak as
          // orphans past the partial save. Run the partial section we were
          // building too, so its sent ids are durable.
          nextSections.push(buildPersistSection(sec.title, newIds, sec.messages, newPinState))
          for (let k = i + 1; k < prev.length; k++) {
            const carried = carryPrev(k)
            if (carried) nextSections.push(carried)
          }
          return fail(err)
        }
        hooks.onSent?.(sent.id)
        newIds.push(sent.id)
        newSentIds.push(sent.id)
        created++
        landedId = sent.id
      }

      // Pin transitions:
      //   desired=true  → pin (always; Discord pin is idempotent for already-pinned)
      //   desired=false + reused message that was previously pinned → unpin
      //   desired=false + new message → no-op
      // Failures stay non-fatal: counter incremented, hook called, run continues.
      let landedPinState = wasPinned && isReused
      if (desiredPin) {
        try {
          const m = await ch.messages.fetch(landedId)
          await m.pin?.()
          pinned++
          landedPinState = true
        } catch (err) {
          pinFailed++
          hooks.onPinError?.(landedId, err)
        }
      } else if (isReused && wasPinned) {
        try {
          const m = await ch.messages.fetch(landedId)
          await m.unpin?.()
          pinned++
          landedPinState = false
        } catch (err) {
          pinFailed++
          hooks.onPinError?.(landedId, err)
        }
      }
      newPinState.push(landedPinState)
    }

    for (let j = chunks.length; j < existingIds.length; j++) {
      const stale = existingIds[j]
      if (!stale) continue
      try {
        const m = await ch.messages.fetch(stale)
        await m.delete()
        deleted++
      } catch {
        // Already gone — fine.
      }
    }

    nextSections.push(buildPersistSection(sec.title, newIds, sec.messages, newPinState))
  }

  // Sections that fell off the end of the new array — delete their backing
  // messages.
  for (let i = sections.length; i < prev.length; i++) {
    const dropped = prev[i]
    if (!dropped) continue
    for (const id of normalizeSection(dropped).messageIds) {
      try {
        const m = await ch.messages.fetch(id)
        await m.delete()
        deleted++
      } catch {}
    }
  }

  return {
    next: { sections: nextSections },
    edited,
    created,
    deleted,
    pinned,
    pinFailed,
    newSentIds,
  }
}

/** Persist-shaped AnchorSection: keeps `messageIds` and `messages` strictly
 *  in lockstep, with the pin state we last successfully applied recorded so
 *  future runs can detect transitions. */
function buildPersistSection(
  title: string,
  ids: string[],
  inputMessages: SectionInput['messages'],
  pinStates: boolean[],
): AnchorSection {
  return {
    title,
    messageIds: ids,
    messages: ids.map((id, idx) => {
      const hint = inputMessages?.[idx]
      const m: { id: string; preview?: string; pinned?: boolean } = { id }
      if (hint?.preview) m.preview = hint.preview
      if (pinStates[idx]) m.pinned = true
      return m
    }),
  }
}

/** Delete every message recorded under `prev`. Reports how many actually went. */
export async function runAnchorClear(
  ch: ChannelLike,
  prev: AnchorSection[],
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  for (const sec of prev) {
    for (const id of sec.messageIds) {
      try {
        const m = await ch.messages.fetch(id)
        await m.delete()
        deleted++
      } catch {
        failed++
      }
    }
  }
  return { deleted, failed }
}

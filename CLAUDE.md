# discord-plugin-patches — agent instructions

Patches to `claude-plugins-official/discord` v0.0.4 (Discord MCP server).
The README is the user-facing reference; this file is the working contract
for agents editing the patches.

## What lives where

| Path                       | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `server.ts`                | Patched plugin entry. Glues `lib/` to discord.js + MCP transport.         |
| `lib/anchors.ts`           | State schema, `readAnchors`, `saveAnchors`, `withAnchorLock`, `commitThreadRecord`, `normalizeSection`. |
| `lib/anchor-runner.ts`     | Pure `runAnchorSet` / `runAnchorClear` with a `ChannelLike` interface; mockable. |
| `lib/chunk.ts`             | Code-fence-aware (` ``` `/`~~~`) chunker, surrogate-pair safe.            |
| `lib/file-lock.ts`         | `withFileLock(path, fn, opts)` — heartbeat + stale-steal lock primitive.  |
| `lib/__mocks__/`           | `MockChannel`/`MockMessage` for tests. NEVER deployed.                    |
| `lib/*.test.ts`            | `bun:test` suite. Currently 55 tests across 4 files.                      |
| `Makefile`                 | `install`, `test`, `build`, `apply`, `check-drift`, `verify-apply`, `check-deps`, `ci`. |
| `scripts/apply.sh`         | Manifest-driven copy onto plugin cache. Consumes `deploy-manifest.sh`.    |
| `scripts/check-drift.sh`   | Diff patched vs. installed; exit 1 on any drift.                          |
| `scripts/verify-apply.sh`  | Clean-room smoke: deploy into mktemp, assert imports resolve.             |
| `scripts/check-deps.ts`    | Catches transitive-only imports (e.g. `zod` via SDK).                     |
| `scripts/deploy-manifest.sh` | Single source of truth for what `apply.sh` ships.                       |

## Stack

- Bun (TypeScript). `bun test`, `bun build`, `bun install`. **Do not use
  Node/npm/jest/ts-node.**
- `@modelcontextprotocol/sdk` for MCP transport (server + tool schema).
- `discord.js` for Discord API (channels, threads, messages, reactions).
- `zod` is currently imported through SDK transitive — see "Accepted risk"
  below.

## Apply flow

```sh
make install        # bun install (first time)
make test           # bun test lib/ (55 tests)
make build          # bun build → dist/server.bundle.js (sanity check only)
make apply          # cp server.ts + manifest lib/*.ts onto plugin cache
make check-drift    # diff manifest vs. installed; exit 1 on drift
make verify-apply   # clean-room: deploy into mktemp, assert bun build succeeds
make check-deps     # warn if any deployed import isn't declared in plugin pkg.json
make ci             # install + test + build + check-drift + verify-apply + check-deps-warn
```

After `make apply`, run `/reload-plugins` inside Claude Code (or fully
restart). **Do not kill the MCP child process directly** — the host does
not auto-respawn on stdio close.

## Anchors v2 (the headline feature)

`todo_anchor_set` / `todo_anchor_get` / `todo_anchor_clear` are the living
task-board primitives. The schema requires:

- `name` on every set call (≤200 chars, control chars + backticks
  sanitised, length-clamped). Top-level fields you OMIT (`kind`,
  `parent`) are preserved from the previous record; `name` is required
  every time.
- `sections[].title` (≤200 chars, sanitised the same way).
- Body cap: 64KB per section. Larger inputs are rejected up front.
- Optional `messages[i].preview` (≤200 chars) and `messages[i].pin`
  (boolean). `pin: true` pins after send/edit; setting it to `false` (or
  omitting) on a previously-pinned chunk causes an explicit `unpin` —
  pin is no longer a one-way ratchet.
- `parent` requires `kind: "thread"`. `parent` + `kind: "channel"` is
  rejected at the handler.
- Failures are surfaced in the response summary (`P pin op(s) (F failed
  — agent should warn the user)`). Pin failures are non-fatal but
  visible.

Persisted shape (`~/.claude/channels/discord/anchors.json`, file-locked):

```ts
type AnchorMessage = { id: string; preview?: string; pinned?: boolean }
type AnchorSection = { messageIds: string[]; title?: string; messages?: AnchorMessage[] }
type AnchorThread  = { sections: AnchorSection[]; name?: string; kind?: 'channel'|'thread'; parent?: { id: string; name?: string } }
```

Legacy reads (records without `name`/`title`/`messages`) are tolerated by
`normalizeSection`: it synthesises `messages` from `messageIds` and emits
the `(legacy — no name set; pass name to next todo_anchor_set to upgrade)`
heading.

## Critical pitfalls

- **Section ordering is positional.** Reordering, inserting in the
  middle, or deleting from the middle of `sections` scrambles the
  rendered thread because the runner edits messages by index. When you
  must restructure, call `todo_anchor_clear` then `set` from scratch.
- **Pin transitions need both directions.** When a slot is re-purposed
  (was pinned, new hint says no pin), the runner must `unpin` —
  otherwise the pin is stuck. The `pinned?: boolean` field on
  `AnchorMessage` records what we last successfully applied so the next
  call can detect the transition. Don't drop that field.
- **Don't skip `normalizeSection` on legacy reads.** `messageIds` may be
  `undefined` on partial pre-overhaul records; the helper defaults to
  `[]` instead of crashing.
- **`sanitizeLabel` is required for every user-supplied string** that
  reaches `anchor_get` rendering. It strips control chars/CRLF (would
  break the indented list layout) and replaces backtick runs with
  U+FF07 (kills code-fence injection into chained agent output).
- **Don't wire `check-deps` into `ci` as fatal.** It's `check-deps-warn`
  in `ci` because of the accepted-risk `zod` transitive (see below).
- **Tests live alongside the runtime in `lib/`** but the deploy manifest
  excludes `*.test.ts` and `__mocks__/` via the non-recursive glob in
  `scripts/deploy-manifest.sh`. If you add `lib/foo/bar.ts` it will NOT
  be deployed (the glob is `lib/*.ts`, no `**`); flatten it or extend
  the manifest.

## Accepted risk

`zod` is imported in `server.ts` but the upstream plugin's `package.json`
declares only `@modelcontextprotocol/sdk` + `discord.js`. `zod` resolves
today via the SDK's transitive (`@modelcontextprotocol/sdk@1.27.x` ships
it), but a future SDK release dropping `zod` will break the bot with
`Cannot find module 'zod'`. Two recovery paths:

1. Patch `package.json` and add it to `deploy-manifest.sh`.
2. Replace the single `z.…` use in `server.ts` with hand-rolled validation.

`make check-deps` is the watchdog. Run it periodically.

## Bot permissions on Discord

- `ManageMessages` — `pin_message`, `todo_anchor_set` with `pin: true`.
- `ManageThreads` — `create_thread` (private), `thread_members`, `update_thread`.
- `ReadMessageHistory` — `fetch_messages`, `search_messages` (also upstream).
- Per-channel allowlist via `/discord:access` skill — `fetchAllowedChannel`
  rejects writes to channels not in `access.json`.

## Skills shipped with this plugin

- `/discord:configure` — bot token + access policy setup.
- `/discord:access` — pair, allowlist, group policy, runtime config.
- `/discord:task-board` — task-thread discipline guide for anchors v2
  (see `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/skills/task-board/SKILL.md`).

## When you change the schema

1. Update `lib/anchors.ts` types and `normalizeSection` migration path.
2. Update `lib/anchor-runner.ts` to honour the new field on read AND
   persist it on the next `buildPersistSection` call.
3. Update `server.ts` schema (`inputSchema`) AND handler (Zod-style
   manual validator); MCP clients may validate against schema alone.
4. Add tests covering: legacy-read tolerance, partial-failure carry,
   round-trip persistence.
5. Bump the README's tool reference table if behaviour visible to the
   caller changed.

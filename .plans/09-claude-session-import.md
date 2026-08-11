# 09 — Import existing Claude Code CLI sessions into T3

## Goal

When a T3 server starts, or when a project is opened, automatically discover the
Claude Code CLI's own on-disk session transcripts for that machine
(`~/.claude/projects/<slug>/*.jsonl`) and import each one as a first-class T3
thread — with full conversation history and a live resume binding — so a session
the user started directly in the `claude` CLI can be continued from any T3
surface (desktop, web, mobile), including over a T3-Connect link to this machine.

No UI changes. No buttons. The importer only writes into the same event log,
projections, and provider-session runtime that a natively-created T3 thread uses,
so imported sessions render and behave identically to ones T3 started itself.

Claude Code only (not Codex/Cursor/Grok/OpenCode) for this work.

## Why this is possible (and why it wasn't before)

T3 only ever resumed sessions **it** created: the resume id comes from a
`resumeCursor` T3 persists per-thread, and nothing populated that cursor from the
outside. The Claude CLI's own transcripts were read only for usage accounting
(`packages/contracts/src/usage.ts:4`), never for resumption, and there was no
discovery/import path for foreign session ids. This feature adds that path.

The Claude SDK's `resume: <session_id>` will happily reattach to any transcript
that exists on disk — so resumption itself is free once T3 owns a thread whose
provider-session binding points at that `session_id`. The work is (a)
reconstructing readable history the T3 way and (b) seeding that binding.

## The 3 stores a thread lives in

| Store | Table | Event-sourced? | Holds |
|---|---|---|---|
| Event log (source of truth) | `orchestration_events` | yes — via `OrchestrationEngine.dispatch` / append | `thread.created`, `thread.message-sent`, activities |
| Read-model projections | `projection_threads`, `projection_thread_messages`, `projection_thread_sessions` | yes (derived by projector) | title, message history, session/turn state |
| Provider runtime binding | `provider_session_runtime` | **no — direct SQL upsert** | `resume_cursor_json`, `runtime_payload_json.cwd` |

An import therefore has **two halves**:

- **Half A — visible thread + history**: event-sourced. Create the thread, then
  emit the same events a live turn leaves behind.
- **Half B — resume binding**: one direct upsert into `provider_session_runtime`
  with `resume_cursor_json = { threadId, resume: <session_id>, resumeSessionAt:
  <last-assistant-uuid>, turnCount }` and `runtime_payload_json.cwd`. This single
  row is the entire reason resume works.

## Input format — the Claude transcript (verified on disk)

Each `~/.claude/projects/<slug>/<session_id>.jsonl` is a DAG of records linked by
`uuid` → `parentUuid`. Verified facts:

- **Filename stem == inner `sessionId`** in every file (each transcript carries
  exactly one distinct `sessionId`). So the resume key is unambiguous: it's the
  filename stem. Fork-on-resume produces a *separate* file with its own id
  (`c9bcbd4c…` resumed → new file `382ef5a5…`). We treat **each file as one
  thread** (fork-continuation files import as their own threads; the user
  archives any redundant ones manually — accepted).
- **`cwd`** is present on records, so we don't need to reverse Claude's slug
  encoding — walk the tree and read each file's own `cwd` (the usage scanner
  already works this way).
- Record `type` values seen: `user`, `assistant`, `attachment`,
  `file-history-delta`, `file-history-snapshot`, `last-prompt`, `mode`,
  `permission-mode`, `queue-operation`.
- **`user`** records come in three flavors: real prompts (`message.content`
  string or blocks), tool-result carriers (`message.content:[tool_result]` +
  `toolUseResult`), and meta (`isMeta:true`, e.g. slash-command stdout).
- **`assistant`** records are **one content block each** (streaming-split):
  `thinking`, `text`, or `tool_use`, chained by `parentUuid`. One logical
  assistant turn = several records.
- **`isSidechain:true`** marks Task sub-agent transcripts, interleaved in the same
  file.
- Bookkeeping types (`mode`, `permission-mode`, `file-history-*`, `attachment`,
  `last-prompt`, `queue-operation`) are not conversation content.

## Output — how a live turn is recorded (verified by trace)

- `projection_thread_messages` is written **only** by `thread.message-sent`
  events (projector `projector.ts:491`). User prompt + assistant text/reasoning
  land here.
- `activities[]` is written by `thread.activity.append` → `thread.activity-appended`
  (`projector.ts:773`). Tool calls, tool results, and subagent tasks land here.
- `projection_thread_sessions` is written by `thread.session.set` and carries
  turn/session **state only** (no content); `latestTurn` running↔completed is how
  turn boundaries are represented (there is no dedicated turn.start/complete
  event).
- The web UI merges **both** messages and activities into one timeline
  (`apps/web/src/session-logic.ts` `deriveTimelineEntries`). So history must
  populate both.
- **Assistant reasoning is live-stream-only** — it is not persisted even in native
  sessions. Imported history will therefore not show thinking blocks. This is
  parity with how T3 treats every session, not a shortcut.

### Content routing table (what the importer emits per transcript record)

| Transcript record | T3 write | Lands in |
|---|---|---|
| real `user` prompt | `thread.message-sent` (role `user`, `streaming:false`) | `messages[]` |
| `assistant` `text` (chained blocks joined) | `thread.message.assistant.delta` (full text) + `thread.message.assistant.complete` | `messages[]` |
| `assistant` `thinking` | (skipped — not durable) | — |
| `assistant` `tool_use` | `thread.activity.append` kind `tool.started` | `activities[]` |
| `user` `tool_result` carrier | `thread.activity.append` kind `tool.completed` | `activities[]` |
| `user` `isMeta` | skipped (or folded into following prompt) | — |
| `isSidechain` `task` start | `thread.activity.append` kind `task.started` | `activities[]` |
| `isSidechain` subagent tool calls | `thread.activity.append` `tool.started`/`tool.completed` tagged `agentId`+`parentToolUseId` | `activities[]` (nested under agent) |
| `isSidechain` task end | `thread.activity.append` kind `task.completed` | `activities[]` |
| turn boundary (session start / next user prompt) | `thread.session.set` running → … → ready | `projection_thread_sessions.latestTurn` |

## Replay path decision — emit domain events directly (NOT the live normalizer)

Two candidate approaches were traced:

- **(A) Drive synthesized `ProviderRuntimeEvent`s through the live ingestion
  pipeline** — rejected. It would (1) fire a real provider call
  (`thread.turn.start` → reactor → `providerService.sendTurn`) and (2) hit
  `processRuntimeEvent`'s stateful lifecycle guards, assistant-text buffering,
  and first-user-message side effects (title/worktree generation). None replays
  deterministically.
- **(B) Emit the same domain events a live turn leaves behind** — chosen. The
  projection is a deterministic fold of the event log by decider+projector, so
  events written this way are indistinguishable from live-turn events; history
  renders identically. We still reuse the exported pure helper
  `runtimeEventToActivities` (`ProviderRuntimeIngestion.ts:360`) to construct the
  activity payloads, so tool/subagent shapes stay byte-identical without invoking
  the stateful `processRuntimeEvent`.

Tradeoff accepted: we build activity payloads ourselves (mitigated by reusing the
exported helper) and give up automatic mirroring of future normalizer changes — a
small price versus the nondeterminism/side-effects of the live pipeline.

### Per-turn emission recipe

Per file: create the thread first (ingestion/projection requires the thread shell
to exist), then per turn, in order:

1. `thread.message-sent` (role `user`, `streaming:false`) — the prompt. (Uses the
   direct event-append path, since the only command that emits a user
   message-sent — `thread.turn.start` — also emits `thread.turn-start-requested`,
   which triggers a live provider call. Exact append API pinned in
   `recon-orchestration.md`.)
2. `thread.session.set` (status `running`, `activeTurnId`) — sets
   `latestTurn=running`.
3. `thread.message.assistant.delta` (full assistant text) then
   `thread.message.assistant.complete` — the assistant reply.
4. One `thread.activity.append` per tool call, tool result, and subagent task
   (payloads via `runtimeEventToActivities`).
5. `thread.session.set` (status `ready`, `activeTurnId:null`) — flips
   `latestTurn` to `completed`.

Then **Half B**: upsert the `provider_session_runtime` binding row.

## Architecture

### New package: `apps/server/src/import/`

Modeled on `apps/server/src/usage/` (an Effect `Context.Service` + `Layer.effect`,
wired via one `Layer.provideMerge(...)` in `server.ts`). Because layers only build
inside the owning server process, the importer automatically runs on the machine
that physically owns `~/.claude` — the T3-Connect/remote case is handled for free.

Files:

- `ClaudeTranscriptParser.ts` — pure. `.jsonl` records → a structured
  `ImportedConversation` model (session id, cwd, model, turns; each turn has a user
  message, assistant text segments, ordered tool calls with results, and nested
  sidechain/subagent activities). Walks the `uuid`/`parentUuid` DAG. No I/O, no
  Effect deps beyond types → trivially unit-testable.
- `ImportTranslator.ts` — pure-ish. `ImportedConversation` → an ordered list of
  orchestration writes (the per-turn recipe) + the resume-binding descriptor.
  Reuses `runtimeEventToActivities` to build activity payloads.
- `ClaudeSessionImportService.ts` — the Effect service. Orchestrates: resolve
  transcript dirs (reuse `UsageService.resolveTranscriptDirs`), `listTranscriptFiles`,
  dedup, parse, translate, dispatch/append, upsert binding. Idempotent.
- `importScanCache.ts` — reuse/mirror `usageScanCache.ts` to memo `(session_id,
  size, mtime)` so re-scans are cheap.
- `*.test.ts` for parser, translator, and an integration test.

Reused verbatim from `usage/`: `usageTranscriptReader.ts`
(`listTranscriptFiles`, `readTranscriptRecords`, `readDirectoryVolumeId`),
`UsageService.resolveTranscriptDirs` (Claude home/transcript-dir resolution).

### Dedup

Key on the Claude `session_id` (= filename stem). Before importing, skip if a
`provider_session_runtime` row already has `resume_cursor_json.resume ==
session_id` (covers both "T3 already owns it" and "already imported"), OR if the
scan-cache already recorded this `(session_id, size, mtime)`. A completed session
file is immutable once its process exits, so the cache makes re-scans nearly free.

### Project association

Read each transcript's `cwd`. Find the T3 project whose workspace root == that
`cwd`. If none exists, create one via `project.create` (exact command in
`recon-orchestration.md`). Threads created by the importer attach to that project.

### Model selection

`thread.create` needs `modelSelection = { instanceId, model }`. Resolve a valid
`claudeAgent` provider instance id (see `recon-persistence.md`); take `model` from
the transcript's assistant records when present, else the instance's default
model.

## Triggers (final — no watcher)

A filesystem watcher was considered and **dropped**: a session is empty at
creation time, so there is nothing to import at the moment a file appears. Two
triggers only:

1. **Boot scan** — a `runStartupPhase("claude-import.backfill", …)` in
   `serverRuntimeStartup.ts` runs a full scan at server start/relaunch. This is
   the primary and safety-net trigger: restart T3 to pick up any sessions started
   in the CLI since. (Killing/relaunching the server never requires
   removing/re-adding a project.)
2. **Project open** — a reactor subscribed to the `project.created` domain event
   (`decider.ts:242`) scans that project's transcripts on open.

Both call the same idempotent `ClaudeSessionImportService.scanAndImport(...)`;
dedup makes overlapping triggers safe.

## Wiring

- `ClaudeSessionImportLayerLive = ClaudeSessionImportService.layer.pipe(
  Layer.provide(<deps: ServerSettings, ProviderSessionDirectory, OrchestrationEngine,
  ProviderInstanceRegistry, SqlClient/Database>))`, merged into
  `RuntimeDependenciesLive` beside `server.ts:419`.
- Boot phase added in `serverRuntimeStartup.ts` alongside `reactors.start`.
- Project-open reactor registered next to the other orchestration reactors
  (`OrchestrationReactor` children), or as a small standalone reactor Layer.

## Build / test / run oracle

(Exact invocations pinned in `recon-tooling.md`.)

- Typecheck: server + contracts packages must pass `tsgo --noEmit`.
- Tests: `vp test run` for the new `import/*.test.ts` — parser and translator have
  focused unit tests; one integration test drives a synthetic transcript through
  the service against an in-memory/migrated DB and asserts (a) a thread +
  messages + activities projection materializes and (b) a `provider_session_runtime`
  row with the right `resume_cursor_json` is written.
- Lint + format: `pnpm lint`, `pnpm fmt` clean (respect `oxlint-plugin-t3code`).
- Runtime confirmation: launch `pnpm dev:server` on this machine (which has real
  `~/.claude/projects/-data-projects-t3code/*.jsonl`), confirm the boot scan
  imports the sessions (log lines + a projections/DB check), open the local web
  app, confirm an imported thread shows history, send a message, and confirm it
  resumes the real transcript (turn succeeds with `claude.resume.source =
  resume-session`).

## Idempotency & safety invariants

- Re-running a scan must never duplicate a thread (dedup by `session_id`).
- The importer must never dispatch `thread.turn.start` (no live provider calls
  during import).
- Importing must be best-effort per file: a malformed transcript is logged and
  skipped, never crashes the boot phase.
- Half B upsert is keyed by `thread_id`; re-import of the same session updates in
  place.

## Out of scope

- Other providers (Codex/Cursor/Grok/OpenCode).
- A live filesystem watcher.
- Merging fork-continuation files into their parent thread.
- Rendering assistant reasoning (not durable anywhere in T3).

## Build order

1. Recon (done — see `mission/recon-*.md`): exact orchestration, persistence, and
   tooling APIs.
2. `ClaudeTranscriptParser.ts` + tests.
3. `ImportTranslator.ts` + tests.
4. `ClaudeSessionImportService.ts` (scan, dedup, thread create, replay, binding
   upsert) + integration test.
5. Triggers + Layer wiring (boot phase, project-open reactor).
6. Full oracle: typecheck, lint, tests green; run the server and confirm an
   imported session resumes end-to-end.

# Plan: CAAM Profile Selection per Session

## Summary

Let a T3 user pick a **caam** account profile (e.g. `jeffhaskin1@gmail.com`) for a
coding session, so the underlying provider CLI runs under that isolated account —
the GUI equivalent of `caam exec claude <profile> --no-lock -- …`. The server
detects profiles created with the external `caam` CLI, exposes them to clients,
and injects the profile's environment into the provider process at launch. A
per-project default (configured via a server env var) applies when a client does
not send a selection, so un-updated clients still land on the right account.

**No changes to the `caam` repo.** T3 shells out to the installed `caam` binary.

## Motivation

Users run one T3 server across personal and work Anthropic/OpenAI subscriptions.
Today the only way to control which account a session uses is to launch the CLI
through `caam` manually. T3 owns the process launch, so it should own the account
selection too — per session, switchable mid-session, with sane per-project
defaults.

## How caam is used (external contract — read-only)

`caam` is already installed (`caam 0.1.13`). We depend on three stable,
`--json`/eval-parseable surfaces (verified against source at
`/data/projects/coding_agent_account_manager`):

- **Detect + list:** `caam ls <tool> --json` →
  `{"profiles":[{"tool","name","active","system","health":{…},"identity":{…}}],"count":N}`.
  `name` is the profile name (an email in practice). Empty `profiles` ⇒ feature off.
- **Resolve env:** `caam env <tool> <profile>` → shell `export KEY="VALUE"` lines.
  For `claude` this emits `HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`
  (`internal/provider/claude/claude.go:243`). We parse these and merge them into
  the provider's spawn env — this reproduces `caam exec` precisely, minus locking
  (we always run unlocked, matching the user's `--no-lock`).
- **Tool mapping:** caam tools are `claude`, `codex`, `gemini`, `agy`. We map T3
  driver kinds → caam tools: `claude → claude`, `codex → codex`. Cursor / Grok /
  OpenCode have no caam tool and are treated as "profiles not applicable".

Rationale for env-injection over an `exec` wrapper: T3's Claude adapter drives the
Claude **Agent SDK** (`query()`), which owns the child argv
(`ClaudeAdapter.ts:4101-4171`); the only launch levers are
`pathToClaudeCodeExecutable`, `env`, `cwd`, and flag-only `extraArgs`. Env
injection is the one mechanism that works uniformly across the SDK path and the
direct-spawn paths (Codex `CODEX_HOME`, ACP spawn env) without reimplementing
caam's vault logic.

## Key architecture facts (from codebase survey)

- RPC = **Effect RPC** over one `orchestration.dispatchCommand` WS method
  (`packages/contracts/src/rpc.ts:835`). Schemas are Effect `Schema` in
  `packages/contracts`.
- A "session" is a **thread**. Thread lifecycle commands live in
  `packages/contracts/src/orchestration.ts`: `ThreadCreateCommand` (653),
  `ThreadTurnStartBootstrapCreateThread` (785), `ThreadTurnStartCommand` (811) +
  wire twin `ClientThreadTurnStartCommand` (832), `ThreadMetaUpdateCommand` (751).
- Event-sourced: command → `decider.ts` → events → `projector.ts` →
  `projection_threads` (SQLite). `modelSelection` is the field to mirror for
  `caamProfile` (persisted per thread; mutable mid-session via `thread.meta.update`).
- **One long-lived provider process per session**, spawned at `startSession`
  (`ProviderService.startSession`), driven from `ProviderCommandReactor.ts:614-632`
  which resolves cwd and instance. Env binds at spawn → **profile change requires a
  respawn**, not a live mutation.
- Provider env seams: Claude `queryOptions.env` (`ClaudeAdapter.ts:4123`, built from
  `makeClaudeEnvironment` at `Drivers/ClaudeHome.ts`); Codex `CODEX_HOME`
  (`CodexSessionRuntime.ts:866`). cwd = `thread.worktreePath ?? project.workspaceRoot`
  (`checkpointing/Utils.ts`).
- Web: shared `ChatComposer` (`apps/web/src/components/chat/ChatComposer.tsx`) for
  both new (draft) and existing (server) sessions. Model picker at 3123; the
  runtime-mode `Select` at 349 is the primitive to mirror. Selections live in the
  zustand `composerDraftStore.ts` (per-thread + sticky), surfaced via
  `getSendContext()` (2604), sent from `ChatView.tsx onSend` (4856). Mid-session
  diff logic: `ChatView.logic.ts resolveThreadMetadataUpdateForNextTurn`.
- Server env config: `apps/server/src/cli/config.ts` (Effect `Config`, `T3CODE_*`),
  surfaced through `ServerConfig` (`apps/server/src/config.ts`).

## Design

### Effective-profile resolution (single source of truth)

At session start, for a thread whose provider maps to caam tool `T` and whose cwd
is `D`:

```
effectiveProfile =
    thread.caamProfile            // explicit user selection (persisted)
 ?? projectDefaultProfile(D, T)   // server env-var default, longest-prefix match
 ?? none                          // → launch with unmodified env (today's behavior)
```

If `effectiveProfile` names a profile that `caam ls T` no longer knows, we log and
fall back to `none` (never block a launch on a stale profile).

### Per-project defaults (server env var)

New config `T3CODE_CAAM_PROFILE_DEFAULTS`, a JSON array:

```json
[{ "path": "/data/projects/thrivelist_mvp", "profile": "marcello@thrivalist.com", "tool": "claude" }]
```

- `tool` optional (default `"claude"`).
- Match = the entry with the **longest `path`** that is a prefix of the thread cwd
  (path-segment aware, so `/a/b` matches `/a/b` and `/a/b/c` but not `/a/bc`).
- Also accept a convenience form for a single default:
  `T3CODE_CAAM_PROFILE_DEFAULT` = `"<profile>"` applied at the server's root (rarely
  used; the JSON form is primary).
- Seed value shipped in docs/`.env.example`: `marcello@thrivalist.com` for
  `/data/projects/thrivelist_mvp`.

Directories with no matching entry ⇒ no default ⇒ no caam unless the user selects.

## Proposed Changes

### Phase 1 — Foundation (server service + config + contracts), no UI

1. `apps/server/src/caam/CaamService.ts` (+ `.test.ts`): Effect service.
   - `available: Effect<boolean>` — cached probe (`caam --version`).
   - `listProfiles(tool): Effect<ReadonlyArray<CaamProfile>>` — runs
     `caam ls <tool> --json`, decodes, TTL-cached (~10s).
   - `resolveEnvironment(tool, profile): Effect<ReadonlyArray<{name,value}>>` — runs
     `caam env <tool> <profile>`, parses `export K="V"`, TTL-cached.
   - Binary configurable via `T3CODE_CAAM_BIN` (default `caam`); all failures are
     non-fatal (feature degrades to "unavailable"). Uses the existing
     `ChildProcessSpawner`/`resolveSpawnCommand` infra, mirroring provider-maintenance
     command execution.
2. `apps/server/src/cli/config.ts` + `apps/server/src/config.ts`: add
   `caamProfileDefaults` (parsed `T3CODE_CAAM_PROFILE_DEFAULTS`) + `caamBin` to
   `ServerConfig`; add `resolveProjectDefaultProfile(cwd, tool)` helper
   (`apps/server/src/caam/ProjectDefaults.ts` + test) for longest-prefix matching.
3. `packages/contracts`:
   - `packages/contracts/src/caam.ts`: `CaamProfileName` (trimmed string),
     `CaamProfile`, `CaamToolProfiles`, `CaamProfilesSnapshot`
     (`{ available, profilesByTool, projectDefaults }`).
   - Add optional `caamProfile: Schema.optional(Schema.NullOr(CaamProfileName))` to
     `ThreadCreateCommand`, `ThreadTurnStartBootstrapCreateThread`,
     `ThreadTurnStartCommand` (+ `ClientThreadTurnStartCommand`),
     `ThreadMetaUpdateCommand`.
   - Add `caamProfile` + `caamEnvironment` (reuse `ProviderInstanceEnvironment`) to
     `ProviderSessionStartInput`.
   - New RPC `orchestration.listCaamProfiles` (payload: environment scope; success:
     `CaamProfilesSnapshot`) in `rpc.ts`, or fold the snapshot into the existing
     server-config projection the client already reads. **Decision: dedicated RPC**
     (keeps the snapshot lazy/refreshable and off the hot config path).

### Phase 2 — Server wiring (persistence + injection + respawn)

4. Persistence: migration `apps/server/src/persistence/Migrations/04X_*.ts` adds
   `caam_profile TEXT` to `projection_threads`; extend
   `persistence/Layers/ProjectionThreads.ts` (read/insert/upsert) and the
   thread-created / thread-meta-updated paths in `orchestration/projector.ts` +
   `orchestration/decider.ts` (new optional field on the existing event payloads;
   backward compatible).
5. `orchestration/Layers/ProviderCommandReactor.ts`: at `startProviderSession`,
   compute `effectiveProfile` (thread projection ?? project default), map driver→tool,
   resolve env via `CaamService`, and pass `caamProfile` + `caamEnvironment` into
   `providerService.startSession`. Same for the resume path in `ProviderService.ts`.
6. `provider/Layers/ClaudeAdapter.ts`: merge `input.caamEnvironment` into
   `queryOptions.env` (`{ ...claudeEnvironment, ...caam }`); store the started profile
   on `ClaudeSessionContext`; in `sendTurn`, if the thread's effective profile differs
   from the started one, tear down + restart the session before the turn (respawn).
7. `provider/Layers/CodexSessionRuntime.ts`: merge `caamEnvironment` into the spawn
   env (best-effort; `CODEX_HOME` from caam wins). ACP/OpenCode: no-op (log once).
8. RPC handler for `listCaamProfiles` in `apps/server/src/orchestration/http.ts`
   (or a small dedicated handler module), wired to `CaamService` + project defaults.

### Phase 3 — Web UI

9. `composerDraftStore.ts`: add `caamProfileByThread` + `stickyCaamProfile` (+ setters),
   mirroring `modelSelectionByProvider`.
10. New `apps/web/src/state/caamProfiles.ts` atom over a `client-runtime` factory for
    the `listCaamProfiles` RPC; `packages/client-runtime` gets the query + command
    plumbing.
11. `apps/web/src/components/chat/CaamProfilePicker.tsx`: a `Select` (mirrors the
    runtime-mode dropdown) rendered in the composer footer **only when**
    `snapshot.available` and the active provider's tool has ≥1 profile. Options =
    profiles for that tool + a "No profile / default" entry. Shows the project
    default as the pre-selected value for new threads.
12. `ChatComposer.tsx` / `ChatView.tsx`: surface the selection through
    `getSendContext()`, thread `caamProfile` into create/start/persist RPCs, and add
    the profile diff branch to `resolveThreadMetadataUpdateForNextTurn`
    (`ChatView.logic.ts`) so a mid-session change emits a `thread.meta.update`.

### Phase 4 — Docs + verification

13. `.env.example` + `docs/operations/caam-profiles.md` (setup: create profiles with
    `caam`, configure `T3CODE_CAAM_PROFILE_DEFAULTS`) and a short `docs/user/` note.
14. Targeted `vp` typecheck/lint/tests for touched packages.

## Provider coverage

| Provider | caam tool | Behavior |
|---|---|---|
| Claude | `claude` | Full: env injection + respawn-on-change (primary target). |
| Codex | `codex` | Best-effort env injection at spawn. |
| Cursor / Grok / OpenCode | — | Picker hidden; selection ignored (logged once). |

## Risks

- **Mid-session respawn** is the highest-risk piece (session replace + Claude resume
  binding). Mitigation: reuse the existing session-replace path; gate behind a
  profile-changed check; keep new sessions (the common case) simple.
- **Continuation-group key** is derived from the Claude home dir; injecting a caam
  env changes the effective home. We keep the instance's configured `homePath`
  unchanged (caam env overlays at the SDK `env` level only), so the continuation key
  and instance-switch guards are unaffected.
- **Stale profile names** (deleted in caam): resolve-time fallback to `none` + log.
- **Performance:** caam shell-outs are TTL-cached and off the turn hot path; the
  profile list is a lazy RPC, not part of the config broadcast.
- **Backward compatibility:** every new field is optional with a default; old clients
  and old persisted rows decode unchanged.

## Validation

- `vp test run` for CaamService, project-default matcher, contract decode tests,
  ProjectionThreads, and adapter env-merge.
- `vp` typecheck + lint for `@t3tools/contracts`, `apps/server`, `apps/web`,
  `packages/client-runtime`.
- Manual: with a real `caam` profile, start a Claude session with the profile
  selected and confirm the account is honored; change it mid-session and confirm the
  next turn respawns under the new account; set `T3CODE_CAAM_PROFILE_DEFAULTS` and
  confirm an un-updated client lands on the default.

## Done Criteria

- Profile dropdown appears in the composer **iff** the server detects caam profiles
  for the active provider's tool, for both new and existing sessions.
- Selecting a profile makes the Claude session run under that caam account; changing
  it mid-session applies to all subsequent turns.
- `T3CODE_CAAM_PROFILE_DEFAULTS` drives per-directory defaults for clients that send
  no selection; unconfigured directories use no caam profile.
- No modifications to the `caam` repository. New fields are backward compatible.

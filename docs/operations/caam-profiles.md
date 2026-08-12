# caam account profiles

T3 Code can run a coding session under a specific provider **account** by
integrating with the external [`caam`](https://github.com/Dicklesworthstone/coding_agent_account_manager)
CLI ("Coding Agent Account Manager"). This is the GUI equivalent of:

```bash
caam exec claude 'jeffhaskin1@gmail.com' --no-lock -- --dangerously-skip-permissions --resume
```

When caam is installed and has profiles, the composer shows an **account picker**
next to the model selector. Picking a profile makes the underlying Claude Code
process run under that account's credentials; you can switch personal ↔ work per
session (and run different sessions under different accounts at the same time).

T3 never modifies caam — it shells out to the installed binary and reuses the
environment caam reports for a profile.

## Setup

1. Install caam and create the profiles you want (one-time, per account):

   ```bash
   caam backup claude 'jeffhaskin1@gmail.com'    # capture the current login
   caam backup claude 'work@company.com'
   caam ls claude                                 # verify they exist
   ```

   T3 detects profiles with `caam ls <tool> --json`. If there are none, no picker
   appears and nothing about the composer changes.

2. (Optional) If `caam` is not on the server's `PATH` as `caam`, point T3 at it:

   ```bash
   T3CODE_CAAM_BIN=/absolute/path/to/caam
   ```

That's it. Restart the T3 server (or reconnect a client) and the picker appears
for Claude sessions.

## Per-project default profiles

Clients that have not been updated to show the picker (older web/desktop/mobile
builds) still need to land on the right account. Configure server-side defaults
keyed by directory:

```bash
# JSON array. The entry whose `path` is the longest prefix of the thread's
# working directory wins. `tool` is optional and defaults to "claude".
T3CODE_CAAM_PROFILE_DEFAULTS='[{"path":"/data/projects/thrivelist_mvp","profile":"marcello@thrivalist.com","tool":"claude"}]'
```

With the example above, any thread rooted at or under
`/data/projects/thrivelist_mvp` uses `marcello@thrivalist.com` unless the client
explicitly selects a different profile. Directories with no matching entry use
**no** caam profile (today's default behavior) unless a profile is chosen in the
UI.

A single catch-all default (applied at `/`, tool `claude`) is also available:

```bash
T3CODE_CAAM_PROFILE_DEFAULT='personal@gmail.com'
```

## How it works

- **Detection / listing:** `caam ls <tool> --json`. The result (minus caam
  "system" profiles) plus the configured per-project defaults ride on the
  server config the client already fetches, so no extra network calls are made.
- **Applying a profile:** at session start T3 resolves the effective profile
  (explicit selection → per-project default → none), runs `caam env <tool>
<profile>`, and overlays the reported variables (`HOME`, `XDG_CONFIG_HOME`,
  `CLAUDE_CONFIG_DIR`) onto the provider process environment. This reproduces
  `caam exec` without the lock, matching a `--no-lock` invocation.
- **Switching mid-session:** the account environment is bound when the provider
  process starts, so changing the profile restarts the session; every turn after
  the change runs under the new account.

## Scope / limitations

- **Claude only** in this release. caam also manages `codex`; wiring the Codex
  app-server launch env is a follow-up. Only tools T3 can actually apply are
  offered in the picker, so a selection is never a silent no-op.
- The selected profile is authored by the client per turn (and backed by the
  per-project default). A server restart in the middle of a session falls back to
  the per-project default for any server-initiated resume until the next
  client-driven turn re-asserts the selection.
- If a selected profile no longer exists in caam, T3 logs a warning and launches
  with the unmodified environment rather than blocking the session.

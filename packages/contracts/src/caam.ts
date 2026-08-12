/**
 * CAAM (Coding Agent Account Manager) contracts.
 *
 * T3 integrates with the external `caam` CLI so a user can run a coding session
 * under a chosen provider account ("profile") without leaving the GUI — the
 * equivalent of `caam exec <tool> <profile> --no-lock -- …`. These schemas are
 * the wire shapes shared by server and clients:
 *
 * - {@link CaamProfilesSnapshot} rides on the client-facing server config and
 *   tells the UI which profiles exist (so a picker appears only when caam is set
 *   up) plus the server's per-project default mapping.
 * - {@link CaamProfileName} is the per-session selection carried on thread
 *   commands.
 *
 * The `caam` repository is never modified; the server shells out to the
 * installed binary.
 *
 * @module contracts/caam
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A caam tool name (`claude`, `codex`, `gemini`, `agy`, …). Kept as a free
 * string rather than a closed union so a newer caam that adds a tool does not
 * fail snapshot decode; the client maps its known provider kinds onto these.
 */
export const CaamToolName = TrimmedNonEmptyString;
export type CaamToolName = typeof CaamToolName.Type;

/**
 * A caam profile name. In practice an account email (e.g.
 * `jeffhaskin1@gmail.com`), but caam allows arbitrary names.
 */
export const CaamProfileName = TrimmedNonEmptyString;
export type CaamProfileName = typeof CaamProfileName.Type;

/** One profile as reported by `caam ls <tool> --json`. */
export const CaamProfile = Schema.Struct({
  tool: CaamToolName,
  name: CaamProfileName,
  /** Whether this profile is the one currently active on the host for the tool. */
  active: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** caam "system" profiles (auto-captured host state) — hidden by default in UI. */
  system: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CaamProfile = typeof CaamProfile.Type;

/** Profiles grouped by the caam tool they belong to. */
export const CaamToolProfiles = Schema.Struct({
  tool: CaamToolName,
  profiles: Schema.Array(CaamProfile),
});
export type CaamToolProfiles = typeof CaamToolProfiles.Type;

/**
 * A server-configured per-project default profile, parsed from
 * `T3CODE_CAAM_PROFILE_DEFAULTS`. Applied by longest matching `path` prefix of a
 * thread's working directory when a client sends no explicit selection.
 */
export const CaamProjectDefault = Schema.Struct({
  path: TrimmedNonEmptyString,
  tool: CaamToolName,
  profile: CaamProfileName,
});
export type CaamProjectDefault = typeof CaamProjectDefault.Type;

/**
 * Everything a client needs to render the profile picker and pre-select a
 * project default. Rides on the client-facing server config under `caam`;
 * absent/`available: false` means no picker is shown.
 */
export const CaamProfilesSnapshot = Schema.Struct({
  /** True when the caam binary is present AND at least one non-system profile exists. */
  available: Schema.Boolean,
  tools: Schema.Array(CaamToolProfiles),
  projectDefaults: Schema.Array(CaamProjectDefault),
});
export type CaamProfilesSnapshot = typeof CaamProfilesSnapshot.Type;

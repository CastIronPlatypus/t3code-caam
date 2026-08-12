/**
 * Web-side helpers for the caam account-profile picker.
 *
 * The server rides a {@link CaamProfilesSnapshot} on its client-facing config
 * (see `@t3tools/contracts`). These pure helpers translate the active provider
 * instance's driver kind onto a caam tool, and derive the selectable profile
 * list plus the per-project default the picker pre-selects. Everything here is
 * side-effect free so it can be shared between the composer (which renders the
 * picker) and ChatView (which decides whether to send the selection).
 *
 * @module caamProfiles
 */
import type { CaamProfilesSnapshot } from "@t3tools/contracts";

/**
 * Sentinel value used by the picker's "Default account" entry. `Select`
 * primitives can't carry a real `null`, so the sentinel stands in for it and is
 * mapped back to `null` at the component boundary (`null` = no explicit
 * selection ⇒ fall back to the server's per-project default).
 */
export const CAAM_DEFAULT_PROFILE_VALUE = "__default__";

/**
 * Map a provider instance's `driverKind` onto the caam tool name it runs under.
 * Returns `undefined` for drivers caam doesn't manage — the picker is hidden in
 * that case.
 */
export function caamToolForDriverKind(driverKind: string): string | undefined {
  switch (driverKind) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    default:
      return undefined;
  }
}

/**
 * The selectable (non-system) profile names for a caam tool. Empty when caam is
 * unavailable, the tool is unknown, or the tool has no user-facing profiles —
 * all cases in which the picker must not render.
 */
export function caamProfileNamesForTool(
  snapshot: CaamProfilesSnapshot | undefined,
  tool: string | undefined,
): readonly string[] {
  if (!snapshot?.available || !tool) {
    return [];
  }
  const entry = snapshot.tools.find((toolProfiles) => toolProfiles.tool === tool);
  if (!entry) {
    return [];
  }
  return entry.profiles.filter((profile) => !profile.system).map((profile) => profile.name);
}

/**
 * The server-configured default profile for a tool at a working directory,
 * resolved by longest matching path prefix (mirrors the server's own
 * resolution). Returns `undefined` when no default applies or `cwd` is unknown.
 */
export function caamProjectDefaultProfile(
  snapshot: CaamProfilesSnapshot | undefined,
  tool: string | undefined,
  cwd: string | null | undefined,
): string | undefined {
  if (!snapshot?.available || !tool || !cwd) {
    return undefined;
  }
  let best: { path: string; profile: string } | undefined;
  for (const projectDefault of snapshot.projectDefaults) {
    if (projectDefault.tool !== tool) {
      continue;
    }
    const path = projectDefault.path;
    const boundary = path.endsWith("/") ? path : `${path}/`;
    const matches = cwd === path || cwd.startsWith(boundary);
    if (!matches) {
      continue;
    }
    if (!best || path.length > best.path.length) {
      best = { path, profile: projectDefault.profile };
    }
  }
  return best?.profile;
}

import { AccountRole } from '@tog/shared';

/**
 * Role → capability map. Mirrors the server-side gate in the API route so the UI
 * only ever offers actions the current account can actually perform. The server
 * remains authoritative; this is purely for hiding/disabling UI (rule G2).
 */
export function can(role: string | undefined) {
  const r = role ?? '';
  return {
    // `group_leader` gets `write: true` here (it is not `readonly`): it needs
    // to mark its own group's attendance and edit its own roster. The
    // NARROWER part of its access — one group, not the whole hall — is not a
    // capability this boolean can express; it is enforced server-side (the
    // group_leader path allowlist + the group-scope guards in
    // `api/[...path]/route.ts`) and reflected in the UI by hiding whole nav
    // entries/pages (`AppShell.visibleItems`), not by a permission flag here.
    /** Create / edit pastoral data (anything but a read-only account). */
    write: r !== AccountRole.ReadOnly,
    /** Hard-delete records — super_admin / admin only. `group_leader` may
     *  never delete, same as every role but these two. */
    delete: r === AccountRole.SuperAdmin || r === AccountRole.Admin,
    /** Manage login accounts (read + write) — super_admin only. */
    manageAccounts: r === AccountRole.SuperAdmin,
  };
}

export type Perms = ReturnType<typeof can>;

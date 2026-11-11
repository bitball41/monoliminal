// Only canonical roles from the server's profile query are permissions.
export type ChatProfile = {
  username: string;
  user_id: string;
  staff_role?: string;
  is_banned?: boolean;
};

const RANK: Record<string, number> = {
  member: 1, mod: 2, manager: 3,
  admin: 4, super_mega_tuff_admin: 4, dusty: 4,
  co_owner: 5, owner: 6, preston: 7,
};

// Custom roles (Chat 6.1) live in public.chat_staff_roles: tier is the
// permission level, power the position. Built-ins are the fallback.
export type RoleInfo = { tier: number; power: number };
export type RoleCatalog = Record<string, RoleInfo>;

function roleInfo(role: string | undefined, catalog: RoleCatalog = {}): RoleInfo | null {
  const slug = (role || '').toLowerCase();
  if (catalog[slug]) return catalog[slug];
  const tier = RANK[slug];
  return tier ? { tier, power: tier * 100 + 50 } : null;
}

export function isOwner(profile: ChatProfile) {
  return !profile.is_banned && ['owner', 'preston'].includes(profile.staff_role || '');
}

// A pre-check only: chat_authorize_password_reset re-checks live roles.
export function canResetPassword(actor: ChatProfile, target: ChatProfile, catalog: RoleCatalog = {}) {
  const a = roleInfo(actor.staff_role, catalog);
  const t = roleInfo(target.staff_role, catalog);
  return !actor.is_banned && !!a && !!t && a.tier >= 4
    && actor.user_id !== target.user_id
    && !['owner', 'preston'].includes(target.staff_role || '')
    && a.power > t.power;
}

// Usernames contain underscores; ILIKE must treat them as literal characters.
export function usernamePattern(value: string) {
  return /^[A-Za-z0-9_]{3,40}$/.test(value) ? value.replaceAll('_', '\\_') : null;
}

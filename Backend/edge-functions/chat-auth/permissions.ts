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

export function isOwner(profile: ChatProfile) {
  return !profile.is_banned && ['owner', 'preston'].includes(profile.staff_role || '');
}

export function canResetPassword(actor: ChatProfile, target: ChatProfile) {
  const actorRank = RANK[actor.staff_role || ''] || 0;
  const targetRank = RANK[target.staff_role || ''] || 0;
  return !actor.is_banned && actorRank >= 4 && targetRank > 0
    && actor.user_id !== target.user_id
    && !['owner', 'preston'].includes(target.staff_role || '')
    && actorRank > targetRank;
}

// Usernames contain underscores; ILIKE must treat them as literal characters.
export function usernamePattern(value: string) {
  return /^[A-Za-z0-9_]{3,40}$/.test(value) ? value.replaceAll('_', '\\_') : null;
}

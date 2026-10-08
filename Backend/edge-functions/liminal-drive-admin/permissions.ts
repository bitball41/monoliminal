// Matches Chat's staff hierarchy. Profile values come from the database, never user metadata.
const UPLOAD_ROLES = new Set(['mod', 'manager', 'admin', 'super_mega_tuff_admin', 'dusty', 'co_owner', 'owner', 'preston']);
const MANAGE_ROLES = new Set(['admin', 'super_mega_tuff_admin', 'dusty', 'co_owner', 'owner', 'preston']);

type Profile = { staff_role?: string; is_owner?: boolean; is_admin?: boolean; is_banned?: boolean };

export function drivePermissions(profile: Profile | null | undefined) {
  if (!profile || profile.is_banned) return { canUpload: false, canManage: false };
  // The deployed profile schema has a canonical staff_role. Ignore legacy flags
  // whenever that field is present, including unrecognised roles.
  const legacyAdmin = !profile.staff_role && Boolean(profile.is_owner || profile.is_admin);
  return {
    canUpload: legacyAdmin || UPLOAD_ROLES.has(profile.staff_role),
    canManage: legacyAdmin || MANAGE_ROLES.has(profile.staff_role),
  };
}

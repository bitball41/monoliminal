// Temporary deployments supply only a capability digest and a short expiry.
// The committed and post-maintenance deployment must always be disabled.
export const maintenanceConfig = { tokenHash: '', expiresAt: 0 };

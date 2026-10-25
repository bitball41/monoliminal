// Disabled in committed source and after each reviewed one-time release.
// A temporary deployment embeds the reviewed artifact and a short-lived
// capability digest. Never commit the capability or a service credential.
export const releaseConfig = { tokenHash:'', expiresAt:0, commit:'', expectedSha256:'' };
export const releaseHtml = '';

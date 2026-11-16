/* ============================================================
   CATALYST - SharePoint Backend Configuration
   ------------------------------------------------------------
   The dashboard must be served from this SharePoint site for
   REST calls to authenticate (session cookie / same-origin).
   If served elsewhere, auth.js falls back to localStorage and
   shows a LOCAL MODE banner on the User Management page.
   ============================================================ */
window.CATALYST_SP_CONFIG = {
  enabled:   true,
  siteUrl:   'https://collaborate.wellpoint.com/sites/T-PaymentIntegrity2025-2026',
  lists: {
    users:   'CATALYST_Users',
    audit:   'CATALYST_AuditLog',
    logins:  'CATALYST_LoginActivity',
    config:  'CATALYST_Configuration',
  },
  // Cache TTL for the users list read (ms) — mutations always write through
  cacheTtlMs: 15000,
};

import { fail } from '@sveltejs/kit';
import { db } from '#lib/db/index.ts';
import { oidcConfig } from '#lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { isAdmin, currentUser as sessionUser, requirePageAdmin } from '#lib/server/auth.ts';
import { decryptField, encryptField } from '#lib/server/encryption.ts';
import { listLegacyOidcLinks, migrateLegacyOidcLink, migrateLegacyOidcLinks, validOidcEndpoint, validOidcIssuer } from '#lib/server/oidc-identity.ts';

export const load = async (event: { locals: App.Locals; url: URL }) => {
  const currentUser = requirePageAdmin(event).user;

  // Load generic OIDC config from DB (take first/only row).
  //
  // `clientSecret` is stored encrypted (see `save`), so it is decrypted here to
  // prefill the form — the same bargain the per-application OIDC settings make
  // with `authConfig`: encrypted at rest, readable by the admin-only form that
  // has to round-trip it. Rows written before it was encrypted come back as
  // plaintext, which `decryptField` passes through and the next save encrypts.
  const stored = await db.select().from(oidcConfig).get();
  const config = stored
    ? { ...stored, clientSecret: decryptField(stored.clientSecret) }
    : null;

  // The callback URL that must be registered in the OIDC provider
  const callbackUrl = `${event.url.origin}/api/auth/oidc/generic/callback`;

  return {
    user: currentUser,
    config: config ?? null,
    callbackUrl,
    legacyOidcLinks: listLegacyOidcLinks(),
  };
};

export const actions = {
  save: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = sessionUser(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    if (!isAdmin(ctx)) return fail(403, { error: 'Forbidden' });

    const formData = await event.request.formData();

    const data = {
      enabled: formData.get('enabled') === 'on',
      providerName: formData.get('providerName')?.toString() || 'Generic OIDC',
      issuerUrl: formData.get('issuerUrl')?.toString().trim() || null,
      clientId: formData.get('clientId')?.toString() || null,
      // Encrypted at rest, like `workers.oidcClientSecret` and an application's
      // `authConfig`. This column was the last credential in the schema kept in
      // plaintext — readable in every `SELECT *`, and uploaded verbatim to Azure
      // by the nightly database backup. `encryptField` is idempotent, so
      // re-saving a row written before this does not double-encrypt.
      clientSecret: encryptField(formData.get('clientSecret')?.toString()),
      authorizationEndpoint: formData.get('authorizationEndpoint')?.toString() || null,
      tokenEndpoint: formData.get('tokenEndpoint')?.toString() || null,
      userinfoEndpoint: formData.get('userinfoEndpoint')?.toString() || null,
      jwksUri: formData.get('jwksUri')?.toString() || null,
      scopes: formData.get('scopes')?.toString() || 'openid email profile',
      usePkce: formData.get('usePkce') !== 'off',
      allowRegistration: formData.get('allowRegistration') !== 'off',
      teamClaimName: formData.get('teamClaimName')?.toString() || null,
      teamClaimKey: formData.get('teamClaimKey')?.toString() || null,
      teamRoleSuffix: formData.get('teamRoleSuffix')?.toString().trim() || null,
    };

    if (data.enabled && (!validOidcIssuer(data.issuerUrl) || !data.clientId ||
        !validOidcEndpoint(data.authorizationEndpoint) || !validOidcEndpoint(data.tokenEndpoint) ||
        !validOidcEndpoint(data.userinfoEndpoint) || (data.jwksUri && !validOidcEndpoint(data.jwksUri)))) {
      return fail(400, { error: 'Enabled OIDC requires an HTTPS issuer, HTTPS provider endpoints, and a client ID.' });
    }
    if (data.enabled && !data.scopes.split(/\s+/).includes('openid')) {
      return fail(400, { error: 'Enabled OIDC requires the openid scope.' });
    }

    const now = new Date();
    const existing = await db.select().from(oidcConfig).get();

    if (existing) {
      await db.update(oidcConfig).set({ ...data, updatedAt: now }).where(eq(oidcConfig.id, existing.id));
    } else {
      await db.insert(oidcConfig).values({ id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now });
    }

    return { success: true };
  },

  migrateLegacy: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = sessionUser(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    if (!isAdmin(ctx)) return fail(403, { error: 'Forbidden' });

    const data = await event.request.formData();
    const cfg = db.select().from(oidcConfig).get();
    if (!cfg || !validOidcIssuer(cfg.issuerUrl) || data.get('issuer') !== cfg.issuerUrl ||
        data.get('confirmLegacyIssuer') !== 'on') {
      return fail(400, { error: 'Confirm that the saved issuer issued all legacy OIDC subjects before migrating.' });
    }
    return { migration: migrateLegacyOidcLinks(cfg.issuerUrl) };
  },

  migrateLegacyAccount: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = sessionUser(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    if (!isAdmin(ctx)) return fail(403, { error: 'Forbidden' });

    const data = await event.request.formData();
    const cfg = db.select().from(oidcConfig).get();
    const linkId = data.get('linkId');
    const subject = data.get('subject');
    if (!cfg || !validOidcIssuer(cfg.issuerUrl) || data.get('issuer') !== cfg.issuerUrl ||
        typeof linkId !== 'string' || !linkId || typeof subject !== 'string' || !subject.trim() ||
        data.get('confirmAccountSubject') !== 'on') {
      return fail(400, { error: 'Verify the subject for this account at the saved issuer before migrating.' });
    }
    if (!migrateLegacyOidcLink(linkId, cfg.issuerUrl, subject)) {
      return fail(409, { error: 'The legacy link changed or the issuer subject is already linked.' });
    }
    return { migration: { migrated: 1, needsReview: 0 } };
  },

  // Admin, like `save` next to it. This makes the server fetch a URL the caller
  // supplies, and it only ever checked that *a* session existed — so any member
  // could aim the control plane at an arbitrary host and read back four fields
  // of the response. It sits on an admin-only page and configures an admin-only
  // setting; there was never a reason for it to be reachable by anyone else.
  discover: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = sessionUser(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    if (!isAdmin(ctx)) return fail(403, { error: 'Forbidden' });

    const formData = await event.request.formData();
    const issuerUrl = formData.get('issuerUrl')?.toString().trim();
    if (!validOidcIssuer(issuerUrl)) return fail(400, { error: 'An HTTPS issuer URL is required.' });

    try {
      const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(discoveryUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return fail(400, { error: `Discovery failed: ${res.status} ${res.statusText}` });
      }
      const meta = await res.json();
      if (meta.issuer !== issuerUrl) {
        return fail(400, { error: 'Discovery returned a different issuer URL. Enter the exact issuer published by your provider.' });
      }
      return {
        discovered: {
          authorizationEndpoint: meta.authorization_endpoint ?? '',
          tokenEndpoint: meta.token_endpoint ?? '',
          userinfoEndpoint: meta.userinfo_endpoint ?? '',
          jwksUri: meta.jwks_uri ?? '',
        },
      };
    } catch (e: any) {
      return fail(400, { error: `Discovery error: ${e.message}` });
    }
  },
};

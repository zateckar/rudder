import { db } from '#lib/db/index.ts';
import { oidcConfig, userOidc, users } from '#lib/db/schema.ts';
import { and, eq, like } from 'drizzle-orm';
import { JwtVerifier } from './mcp/jwt';

const LEGACY_PREFIX = 'generic:';

export function oidcProviderId(issuer: string, subject: string): string {
  return `generic-v2:${JSON.stringify([issuer, subject])}`;
}

export function validOidcIssuer(value: string | null | undefined): value is string {
  return validOidcEndpoint(value) && !value.includes('?');
}

export function validOidcEndpoint(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !value.includes('#');
  } catch {
    return false;
  }
}

let verifier: { issuer: string; jwksUri: string | null; jwt: JwtVerifier } | undefined;

export function verifyLoginIdToken(
  token: string,
  config: { issuerUrl: string; jwksUri: string | null; clientId: string },
  nonce: string,
) {
  const { issuerUrl: issuer, jwksUri, clientId } = config;
  if (!verifier || verifier.issuer !== issuer || verifier.jwksUri !== jwksUri) {
    verifier = { issuer, jwksUri, jwt: new JwtVerifier({
      issuer,
      jwksUri,
      fetch: (url, init) => {
        if (!validOidcEndpoint(url)) throw new Error('OIDC key and discovery endpoints must use HTTPS');
        return fetch(url, { ...init, redirect: 'error' });
      },
    }) };
  }
  return verifier.jwt.verifyIdToken(token, clientId, nonce);
}

const legacyLinks = and(eq(userOidc.provider, 'auth0'), like(userOidc.providerId, `${LEGACY_PREFIX}%`));

export function listLegacyOidcLinks() {
  return db.select({ id: userOidc.id, username: users.username, providerId: userOidc.providerId })
    .from(userOidc).innerJoin(users, eq(users.id, userOidc.userId))
    .where(legacyLinks).orderBy(users.username).all();
}

export function migrateLegacyOidcLink(id: string, issuer: string, subject: string): boolean {
  return db.transaction((tx) => {
    const providerId = oidcProviderId(issuer, subject);
    if (tx.select({ id: userOidc.id }).from(userOidc)
      .where(and(eq(userOidc.provider, 'auth0'), eq(userOidc.providerId, providerId))).get()) return false;
    return !!tx.update(userOidc).set({ providerId })
      .where(and(legacyLinks, eq(userOidc.id, id))).returning({ id: userOidc.id }).get();
  });
}

/** Only an administrator who knows the original issuer can approve a legacy migration. */
export function migrateLegacyOidcLinks(issuer: string): { migrated: number; needsReview: number } {
  return db.transaction((tx) => {
    const links = tx.select().from(userOidc).where(legacyLinks).all();
    const frequencies = new Map<string, number>();
    for (const link of links) {
      frequencies.set(link.providerId, (frequencies.get(link.providerId) ?? 0) + 1);
    }
    let migrated = 0;
    for (const link of links) {
      const subject = link.providerId.slice(LEGACY_PREFIX.length);
      // Older versions sometimes used an email in place of a missing subject.
      // Such a row needs an individually verified subject and cannot be migrated in bulk.
      if (!subject.trim() || subject.includes('@') || frequencies.get(link.providerId) !== 1) continue;
      const providerId = oidcProviderId(issuer, subject);
      if (tx.select({ id: userOidc.id }).from(userOidc)
        .where(and(eq(userOidc.provider, 'auth0'), eq(userOidc.providerId, providerId))).get()) continue;
      tx.update(userOidc).set({ providerId }).where(eq(userOidc.id, link.id)).run();
      migrated++;
    }
    return { migrated, needsReview: links.length - migrated };
  });
}

/** One-time migration for installations where every administrator uses OIDC. */
export function migrateLegacyOidcAtStartup(issuer: string) {
  const saved = db.select({ issuer: oidcConfig.issuerUrl }).from(oidcConfig).get()?.issuer;
  if (!validOidcIssuer(saved) || saved !== issuer) {
    throw new Error('The migration issuer must exactly match the saved OIDC issuer.');
  }
  return migrateLegacyOidcLinks(issuer);
}

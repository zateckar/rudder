import { v4 as uuid } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { users, userOidc } from '../db/schema';
import { env } from '../server/env';
import { createSession } from './index';

export type OIDCProvider = 'google' | 'github' | 'okta' | 'auth0';

interface OIDCConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
}

interface OIDCUserInfo {
  id: string;
  email: string;
  name: string;
  preferredUsername?: string;
  displayName?: string;
  picture?: string;
}

const OIDC_CONFIGS: Record<OIDCProvider, () => OIDCConfig | null> = {
  google: () => {
    if (!env.OIDC_GOOGLE_CLIENT_ID || !env.OIDC_GOOGLE_CLIENT_SECRET) return null;
    return {
      clientId: env.OIDC_GOOGLE_CLIENT_ID,
      clientSecret: env.OIDC_GOOGLE_CLIENT_SECRET,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      scopes: ['openid', 'email', 'profile'],
    };
  },
  github: () => {
    if (!env.OIDC_GITHUB_CLIENT_ID || !env.OIDC_GITHUB_CLIENT_SECRET) return null;
    return {
      clientId: env.OIDC_GITHUB_CLIENT_ID,
      clientSecret: env.OIDC_GITHUB_CLIENT_SECRET,
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userInfoUrl: 'https://api.github.com/user',
      scopes: ['user:email'],
    };
  },
  okta: () => {
    if (!env.OIDC_OKTA_CLIENT_ID || !env.OIDC_OKTA_CLIENT_SECRET || !env.OIDC_OKTA_DOMAIN) return null;
    return {
      clientId: env.OIDC_OKTA_CLIENT_ID,
      clientSecret: env.OIDC_OKTA_CLIENT_SECRET,
      authorizationUrl: `https://${env.OIDC_OKTA_DOMAIN}/oauth2/default/v1/authorize`,
      tokenUrl: `https://${env.OIDC_OKTA_DOMAIN}/oauth2/default/v1/token`,
      userInfoUrl: `https://${env.OIDC_OKTA_DOMAIN}/oauth2/default/v1/userinfo`,
      scopes: ['openid', 'email', 'profile'],
    };
  },
  auth0: () => {
    if (!env.OIDC_AUTH0_CLIENT_ID || !env.OIDC_AUTH0_CLIENT_SECRET || !env.OIDC_AUTH0_DOMAIN) return null;
    return {
      clientId: env.OIDC_AUTH0_CLIENT_ID,
      clientSecret: env.OIDC_AUTH0_CLIENT_SECRET,
      authorizationUrl: `https://${env.OIDC_AUTH0_DOMAIN}/authorize`,
      tokenUrl: `https://${env.OIDC_AUTH0_DOMAIN}/oauth/token`,
      userInfoUrl: `https://${env.OIDC_AUTH0_DOMAIN}/userinfo`,
      scopes: ['openid', 'email', 'profile'],
    };
  },
};

export function getOIDCConfig(provider: OIDCProvider): OIDCConfig | null {
  const configFn = OIDC_CONFIGS[provider];
  return configFn ? configFn() : null;
}

export function getEnabledProviders(): OIDCProvider[] {
  const providers: OIDCProvider[] = [];
  if (env.OIDC_GOOGLE_CLIENT_ID && env.OIDC_GOOGLE_CLIENT_SECRET) providers.push('google');
  if (env.OIDC_GITHUB_CLIENT_ID && env.OIDC_GITHUB_CLIENT_SECRET) providers.push('github');
  if (env.OIDC_OKTA_CLIENT_ID && env.OIDC_OKTA_CLIENT_SECRET && env.OIDC_OKTA_DOMAIN) providers.push('okta');
  if (env.OIDC_AUTH0_CLIENT_ID && env.OIDC_AUTH0_CLIENT_SECRET && env.OIDC_AUTH0_DOMAIN) providers.push('auth0');
  return providers;
}

export function generateAuthorizationUrl(provider: OIDCProvider, state: string, redirectUri: string): string | null {
  const config = getOIDCConfig(provider);
  if (!config) return null;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
  });

  return `${config.authorizationUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  provider: OIDCProvider,
  code: string,
  redirectUri: string
): Promise<string | null> {
  const config = getOIDCConfig(provider);
  if (!config) return null;

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    console.error('Token exchange failed:', await response.text());
    return null;
  }

  const data = await response.json();
  return data.access_token;
}

export async function getUserInfo(provider: OIDCProvider, accessToken: string): Promise<OIDCUserInfo | null> {
  const config = getOIDCConfig(provider);
  if (!config) return null;

  const response = await fetch(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    console.error('User info fetch failed:', await response.text());
    return null;
  }

  const data = await response.json();

  // Normalize user info based on provider
  if (provider === 'github') {
    // GitHub requires separate email endpoint if email is private
    let email = data.email;
    if (!email) {
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      if (emailRes.ok) {
        const emails = await emailRes.json();
        const primary = emails.find((e: any) => e.primary);
        email = primary?.email || emails[0]?.email;
      }
    }
    return {
      id: String(data.id),
      email: email || `${data.login}@github.local`,
      name: data.name || data.login,
      preferredUsername: data.login,
      displayName: data.name,
      picture: data.avatar_url,
    };
  }

  // Google, Okta, Auth0 follow standard OIDC
  return {
    id: data.sub || data.id,
    email: data.email,
    name: data.display_name || data.name || data.preferred_username || data.email?.split('@')[0] || 'User',
    preferredUsername: data.preferred_username,
    displayName: data.display_name || data.name,
    picture: data.picture,
  };
}

export async function findOrCreateUserFromOIDC(
  provider: OIDCProvider,
  userInfo: OIDCUserInfo
): Promise<{ userId: string; isNew: boolean }> {
  // Check if OIDC connection exists
  const existingOidc = await db
    .select()
    .from(userOidc)
    .where(and(eq(userOidc.provider, provider), eq(userOidc.providerId, userInfo.id)))
    .get();

  if (existingOidc) {
    // Update last synced
    await db
      .update(userOidc)
      .set({ lastSyncedAt: new Date() })
      .where(eq(userOidc.id, existingOidc.id));
    return { userId: existingOidc.userId, isNew: false };
  }

  // Check if user with same email exists
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, userInfo.email))
    .get();

  if (existingUser) {
    // Link OIDC to existing user
    await db.insert(userOidc).values({
      id: uuid(),
      userId: existingUser.id,
      provider,
      providerId: userInfo.id,
      lastSyncedAt: new Date(),
    });
    return { userId: existingUser.id, isNew: false };
  }

  // Create new user
  const userId = uuid();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    username: userInfo.preferredUsername || generateUsername(userInfo.email),
    email: userInfo.email,
    passwordHash: null, // OIDC users don't have passwords
    fullName: userInfo.displayName || userInfo.name,
    role: 'member',
    createdAt: now,
    updatedAt: now,
  });

  // Create OIDC link
  await db.insert(userOidc).values({
    id: uuid(),
    userId,
    provider,
    providerId: userInfo.id,
    lastSyncedAt: now,
  });

  return { userId, isNew: true };
}

function generateUsername(email: string): string {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return `${base}${Math.floor(Math.random() * 1000)}`;
}

export async function handleOIDCCallback(
  provider: OIDCProvider,
  code: string,
  redirectUri: string
): Promise<{ sessionId: string; isNew: boolean } | null> {
  const accessToken = await exchangeCodeForToken(provider, code, redirectUri);
  if (!accessToken) return null;

  const userInfo = await getUserInfo(provider, accessToken);
  if (!userInfo) return null;

  const { userId, isNew } = await findOrCreateUserFromOIDC(provider, userInfo);
  const sessionId = await createSession(userId);

  return { sessionId, isNew };
}

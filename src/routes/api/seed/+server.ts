import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { users, teams, teamMembers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { v4 as uuid } from 'uuid';
import { env } from '$env/dynamic/private';

export async function POST({ request, cookies, locals }: { request: Request; cookies: any; locals: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  // Require authentication
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;

  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require admin role or a valid seed token
  const body = await request.json().catch(() => ({}));
  const seedToken = body.token || request.headers.get('x-seed-token');

  const isAuthorized = locals.userRole === 'admin' || (env.SEED_TOKEN && seedToken === env.SEED_TOKEN);

  if (!isAuthorized) {
    return json({ error: 'Forbidden - admin access or valid seed token required' }, { status: 403 });
  }

  // Check if admin user already exists
  const existingAdmin = await db.select()
    .from(users)
    .where(eq(users.username, 'admin'))
    .get();

  if (existingAdmin) {
    return json({ success: false, error: 'Admin user already exists' });
  }

  const hashedPassword = await bcrypt.hash('admin123', 10);
  const userId2 = uuid();
  const teamId = uuid();

  // Create admin user
  await db.insert(users).values({
    id: userId2,
    username: 'admin',
    email: 'admin@example.com',
    fullName: 'Admin User',
    passwordHash: hashedPassword,
    role: 'admin',
    createdAt: new Date(),
    updatedAt: new Date()
  });

  // Create default team
  await db.insert(teams).values({
    id: teamId,
    name: 'Default Team',
    slug: 'default-team',
    createdBy: userId2,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  // Add user to team
  await db.insert(teamMembers).values({
    userId: userId2,
    teamId,
    role: 'owner',
    joinedAt: new Date()
  });

  return json({
    success: true,
    message: 'Admin user created',
    username: 'admin',
  });
}

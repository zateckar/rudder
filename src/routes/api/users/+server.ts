import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, validatePassword } from '$lib/auth';
import { requireAdminUser, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const allUsers = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users).all();

  return json(allUsers);
});

export const POST: RequestHandler = route(async (event) => {
  requireAdminUser(event);

  const body = await event.request.json();
  const { username, email, password, fullName, role } = body;

  if (!username || !email || !fullName) {
    return json({ error: 'Username, email, and fullName are required' }, { status: 400 });
  }

  // Accounts created here sign in with a local password. Ones federated through
  // OIDC are created by that callback and never come through this endpoint.
  const passwordError = validatePassword(password);
  if (passwordError) {
    return json({ error: passwordError }, { status: 400 });
  }

  // Check for existing user
  const existingUser = await db.select().from(users)
    .where(eq(users.username, username))
    .get();
  
  if (existingUser) {
    return json({ error: 'Username already exists' }, { status: 409 });
  }

  const existingEmail = await db.select().from(users)
    .where(eq(users.email, email))
    .get();
  
  if (existingEmail) {
    return json({ error: 'Email already exists' }, { status: 409 });
  }

  const newUserId = crypto.randomUUID();
  const now = new Date();

  await db.insert(users).values({
    id: newUserId,
    username,
    email,
    passwordHash: password ? await hashPassword(password) : null,
    fullName,
    role: role === 'admin' ? 'admin' : 'member',
    createdAt: now,
    updatedAt: now,
  });

  const created = await db.select({
    id: users.id,
    username: users.username,
    email: users.email,
    fullName: users.fullName,
    role: users.role,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.id, newUserId)).get();

  return json(created, { status: 201 });
});

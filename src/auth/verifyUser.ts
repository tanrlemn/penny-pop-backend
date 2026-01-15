import { getSupabaseServerClient } from '../supabase/serverClient';

export interface VerifiedUser {
  userId: string;
  email: string | null;
}

function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new Error('Missing Authorization header');
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error('Invalid Authorization header format (expected: Bearer <token>)');
  }

  const token = match[1].trim();
  if (!token) {
    throw new Error('Missing Bearer token');
  }

  return token;
}

export async function verifyUser(
  authorizationHeader: string | undefined,
): Promise<VerifiedUser> {
  const token = extractBearerToken(authorizationHeader);

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser(token);

  if (error) {
    throw new Error(`Supabase auth.getUser failed: ${error.message}`);
  }
  if (!data.user) {
    throw new Error('Invalid token (no user)');
  }

  return { userId: data.user.id, email: data.user.email ?? null };
}


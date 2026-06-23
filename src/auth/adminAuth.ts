// src/auth/adminAuth.ts
import { supabase } from '../lib/supabase';

/** Sign in an admin/lead via email + password. Throws on auth error. */
export async function adminSignIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** Sign out the current session. Throws on error. */
export async function adminSignOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

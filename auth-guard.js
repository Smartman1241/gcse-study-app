// auth-guard.js
import { createClient } from "@supabase/supabase-js";

/*
===============================
Centralized Supabase Client
===============================
Uses environment variables instead of hardcoded keys.
For client-side usage, you may still use the public anon key.
*/
const SUPABASE_URL = process.env.SUPABASE_URL || "https://mgpwknnbhaljsscsvucm.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/*
===============================
Authentication Helpers
===============================
*/

// Pages that require a logged-in user
export async function requireAuth() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();

    if (!session) {
      window.location.replace("start.html");
      return null;
    }

    return session;
  } catch (err) {
    console.error("Error checking auth session:", err);
    window.location.replace("start.html");
    return null;
  }
}

// Pages that require the user to be logged out
export async function redirectIfLoggedIn() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();

    if (session) {
      window.location.replace("index.html");
    }
  } catch (err) {
    console.error("Error checking auth session:", err);
  }
}

// Optional: expose globally for inline HTML usage
window.requireAuth = requireAuth;
window.redirectIfLoggedIn = redirectIfLoggedIn;
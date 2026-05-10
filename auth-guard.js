// auth-guard.js
import { createClient } from "@supabase/supabase-js";

/*
===============================
Centralized Supabase Client
===============================
Reuses the global client if available (from theme.js), otherwise creates a new one.
This prevents multiple client instances and race conditions.
*/
// Note: Credentials centralized in theme.js window.REVISEFLOW_CONFIG
// Protected by Supabase Row Level Security (RLS) policies
const CONFIG = window.REVISEFLOW_CONFIG?.supabase || {
  url: "https://mgpwknnbhaljsscsvucm.supabase.co",
  anonKey: "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs"
};

export const supabaseClient = window.supabaseClient || createClient(CONFIG.url, CONFIG.anonKey);

// Make sure window reference is set for other modules
if (!window.supabaseClient) {
  window.supabaseClient = supabaseClient;
}

/*
===============================
Authentication Helpers
===============================
*/

// Pages that require a logged-in user
export async function requireAuth() {
  // Check if we're already on the auth page to prevent redirect loop
  const currentPath = window.location.pathname;
  if (currentPath.includes('start.html') || currentPath.includes('auth.html')) {
    return null;
  }

  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();

    // If there's an error or no session, redirect to start
    if (error || !session) {
      // Use a flag to prevent infinite loop
      const redirectKey = 'auth_redirect_attempted';
      const lastRedirect = sessionStorage.getItem(redirectKey);
      const now = Date.now();

      // If we tried to redirect less than 5 seconds ago, don't try again
      if (lastRedirect && (now - parseInt(lastRedirect)) < 5000) {
        console.error("Auth redirect loop detected, clearing session");
        sessionStorage.removeItem(redirectKey);
        return null;
      }

      sessionStorage.setItem(redirectKey, now.toString());
      window.location.replace("start.html");
      return null;
    }

    // Clear redirect flag on successful auth
    sessionStorage.removeItem('auth_redirect_attempted');
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
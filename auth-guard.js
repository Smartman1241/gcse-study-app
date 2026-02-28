// auth-guard.js
const SUPABASE_URL = "https://mgpwknnbhaljsscsvucm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

// Fail-safe: if Supabase CDN didn't load, don't crash the page
if (!window.supabase || typeof window.supabase.createClient !== "function") {
  console.error("Supabase client not available (CDN failed to load).");
} else {
  const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

  // ✅ Use on pages that MUST be logged in (index.html, account.html, etc.)
  async function requireAuth() {
    const {
      data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session) {
      window.location.replace("start.html");
      return null;
    }

    return session;
  }

  // ✅ Use on pages that MUST be logged out (start.html, auth.html)
  async function redirectIfLoggedIn() {
    const {
      data: { session }
    } = await supabaseClient.auth.getSession();

    if (session) {
      // ✅ FIX: home.html doesn't exist
      window.location.replace("index.html");
    }
  }

  // Expose functions globally for inline HTML usage
  window.requireAuth = requireAuth;
  window.redirectIfLoggedIn = redirectIfLoggedIn;
}
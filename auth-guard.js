// auth-guard.js
const supabaseClient = window.getSupabaseClient ? window.getSupabaseClient() : window.supabaseClient;

// ✅ Use on pages that MUST be logged in (home.html, index.html, account.html, etc.)
async function requireAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (!session) {
    window.location.replace("start.html");
    return null;
  }

  return session;
}

// ✅ Use on pages that MUST be logged out (start.html, auth.html)
async function redirectIfLoggedIn() {
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    window.location.replace("home.html");
  }
}
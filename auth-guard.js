// auth-guard.js
const SUPABASE_URL = "https://mgpwknnbhaljsscsvucm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

const supabaseClient = window.supabase?.createClient
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ✅ Use on pages that MUST be logged in (home.html, index.html, account.html, etc.)
async function requireAuth() {
  if (!supabaseClient) {
    window.location.replace("start.html");
    return null;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();

  if (!session) {
    window.location.replace("start.html");
    return null;
  }

  return session;
}

// ✅ Use on pages that MUST be logged out (start.html, auth.html)
async function redirectIfLoggedIn() {
  if (!supabaseClient) return;

  const { data: { session } } = await supabaseClient.auth.getSession();

  if (session) {
    window.location.replace("index.html");
  }
}

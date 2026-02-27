(function () {
  const SUPABASE_URL = "https://mgpwknnbhaljsscsvucm.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";

  function getSupabaseClient() {
    if (window.supabaseClient) return window.supabaseClient;
    if (!window.supabase || typeof window.supabase.createClient !== "function") return null;
    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.supabaseClient;
  }

  window.getSupabaseClient = window.getSupabaseClient || getSupabaseClient;
  if (!window.supabaseClient) {
    window.getSupabaseClient();
  }
})();

(function () {
  if (window.__rfAiSidebarLoaded) return;
  window.__rfAiSidebarLoaded = true;

  function ensureSupabaseClient() {
    if (!window.supabase || !window.supabase.createClient) return null;
    if (window.supabaseClient) return window.supabaseClient;
    const SUPABASE_URL = "https://mgpwknnbhaljsscsvucm.supabase.co";
    const SUPABASE_KEY = "sb_publishable_6tdnozSH6Ck75uDgXPN-sg_Mn7vyLFs";
    window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return window.supabaseClient;
  }

  function injectStyle() {
    if (document.getElementById("rf-ai-style")) return;
    const style = document.createElement("style");
    style.id = "rf-ai-style";
    style.textContent = `
      :root { --rf-ai-w: min(520px, 92vw); }
      body.rf-ai-open { padding-right: var(--rf-ai-w); transition: padding-right .2s ease; }
      .rf-ai-fab{position:fixed;right:18px;bottom:18px;z-index:3500;border-radius:999px;padding:10px 14px;border:1px solid rgba(255,255,255,.18);background:rgba(142,162,255,.22);color:#fff;cursor:pointer}
      .rf-ai-panel{position:fixed;top:0;right:0;width:var(--rf-ai-w);height:100vh;z-index:3400;display:none;flex-direction:column;background:rgba(12,16,30,.95);border-left:1px solid rgba(255,255,255,.12);box-shadow:-14px 0 40px rgba(0,0,0,.35)}
      .rf-ai-head{padding:12px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,.12)}
      .rf-ai-body{padding:14px;display:flex;gap:10px;flex-direction:column;overflow:auto;flex:1}
      .rf-ai-row{display:flex;gap:8px;flex-wrap:wrap}
      .rf-ai-row button,.rf-ai-head button,.rf-ai-actions button{border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;border-radius:10px;padding:8px 10px;cursor:pointer}
      .rf-ai-input{width:100%;min-height:108px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#fff;padding:10px;resize:vertical}
      .rf-ai-out{white-space:pre-wrap;border:1px solid rgba(255,255,255,.15);border-radius:10px;background:rgba(255,255,255,.04);padding:10px;min-height:140px;color:rgba(255,255,255,.92)}
      .rf-ai-actions{display:flex;gap:8px;flex-wrap:wrap}
      @media (max-width: 980px){ body.rf-ai-open{padding-right:0}.rf-ai-panel{width:100vw} }
    `;
    document.head.appendChild(style);
  }

  let currentTier = "free";

  function buildUi() {
    if (document.getElementById("rfAiPanel")) return;
    const fab = document.createElement("button");
    fab.id = "rfAiFab";
    fab.className = "rf-ai-fab";
    fab.type = "button";
    fab.textContent = "🤖 AI";

    const panel = document.createElement("aside");
    panel.id = "rfAiPanel";
    panel.className = "rf-ai-panel";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <div class="rf-ai-head">
        <div><b>ReviseFlow AI</b><div style="font-size:12px;opacity:.75" id="rfAiPlan">Loading plan…</div></div>
        <button type="button" id="rfAiClose">✕</button>
      </div>
      <div class="rf-ai-body">
        <div class="rf-ai-row">
          <button type="button" data-rf-q="Explain this simply: ">Explain</button>
          <button type="button" data-rf-q="Give me a GCSE exam-style question on: ">Exam Q</button>
          <button type="button" data-rf-q="Give me 5 quick quiz questions on: ">Quiz</button>
          <button type="button" id="rfAiDetailedBtn" data-rf-q="Explain step-by-step in full GCSE detail: ">Detailed (Plus/Pro)</button>
        </div>
        <textarea id="rfAiInput" class="rf-ai-input" maxlength="12000" placeholder="Ask a GCSE question…"></textarea>
        <div class="rf-ai-actions">
          <button type="button" id="rfAiAsk">Ask AI</button>
          <button type="button" id="rfAiClear">Clear</button>
        </div>
        <div id="rfAiOut" class="rf-ai-out">Your answer will appear here.</div>
      </div>`;

    document.body.appendChild(fab);
    document.body.appendChild(panel);
  }

  function openPanel() {
    const panel = document.getElementById("rfAiPanel");
    if (!panel) return;
    panel.style.display = "flex";
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("rf-ai-open");
  }

  function closePanel() {
    const panel = document.getElementById("rfAiPanel");
    if (!panel) return;
    panel.style.display = "none";
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("rf-ai-open");
  }

  async function getTierLabel(sb, userId) {
    try {
      const { data } = await sb.from("user_settings").select("username,tier,role").eq("user_id", userId).maybeSingle();
      return {
        username: data?.username || null,
        tier: String(data?.tier || data?.role || "free").toLowerCase()
      };
    } catch {
      return { username: null, tier: "free" };
    }
  }

  async function streamOrRender(res, outEl) {
    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/event-stream") && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      outEl.textContent = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") outEl.textContent += payload;
          }
        }
      }
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      outEl.textContent = data?.error || "AI request failed.";
      return;
    }
    const reply = String(data?.reply || "");
    outEl.textContent = "";
    for (let i = 0; i < reply.length; i += 18) {
      outEl.textContent += reply.slice(i, i + 18);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  async function askAi() {
    const sb = ensureSupabaseClient();
    const out = document.getElementById("rfAiOut");
    const input = document.getElementById("rfAiInput");
    if (!sb || !out || !input) return;

    const question = String(input.value || "").trim();
    if (!question) {
      out.textContent = "Type a question first.";
      return;
    }

    out.textContent = "Thinking…";
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) {
      out.textContent = "Please log in again.";
      window.location.href = "auth.html";
      return;
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ question, timezone, model: (currentTier === "plus" || currentTier === "pro") ? "gpt-5-mini" : "gpt-4o-mini" })
    });

    if (res.status === 401) {
      out.textContent = "Session expired. Please log in again.";
      window.location.href = "auth.html";
      return;
    }

    await streamOrRender(res, out);
  }

  async function init() {
    if (!window.supabase || document.body?.dataset?.disableSharedAi === "1") return;
    const sb = ensureSupabaseClient();
    if (!sb) return;

    const { data: { session } } = await sb.auth.getSession();
    if (!session?.user) return;

    injectStyle();
    buildUi();

    const who = await getTierLabel(sb, session.user.id);
    currentTier = who.tier;
    const tierLabel = who.tier === "pro" ? "Pro" : (who.tier === "plus" ? "Plus" : "Free");
    const planEl = document.getElementById("rfAiPlan");
    if (planEl) {
      planEl.textContent = `${who.username || "Student"} • ${tierLabel}`;
    }

    const detailedBtn = document.getElementById("rfAiDetailedBtn");
    if (detailedBtn && !(currentTier === "plus" || currentTier === "pro")) {
      detailedBtn.disabled = true;
      detailedBtn.title = "Upgrade to Plus or Pro to unlock detailed mode";
      detailedBtn.textContent = "Detailed (locked)";
    }

    document.getElementById("rfAiFab")?.addEventListener("click", openPanel);
    document.getElementById("rfAiClose")?.addEventListener("click", closePanel);
    document.getElementById("rfAiAsk")?.addEventListener("click", askAi);
    document.getElementById("rfAiClear")?.addEventListener("click", () => {
      const input = document.getElementById("rfAiInput");
      const out = document.getElementById("rfAiOut");
      if (input) input.value = "";
      if (out) out.textContent = "Your answer will appear here.";
    });

    document.querySelectorAll("[data-rf-q]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prefix = btn.getAttribute("data-rf-q") || "";
        const input = document.getElementById("rfAiInput");
        if (!input) return;
        const current = String(input.value || "").trim();
        input.value = current ? `${prefix}${current}` : prefix;
        input.focus();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

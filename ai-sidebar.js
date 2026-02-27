(function(){
  if (window.__rfAiSidebarLoaded) return;
  window.__rfAiSidebarLoaded = true;

  const AI_CLASS = 'rf-ai-open';

  function ensureStyles(){
    if (document.getElementById('rf-ai-sidebar-style')) return;
    const style = document.createElement('style');
    style.id = 'rf-ai-sidebar-style';
    style.textContent = `
      body{transition:padding-right .2s ease;}
      body.${AI_CLASS}{padding-right:min(420px,92vw)}
      .rf-ai-fab{position:fixed;right:16px;bottom:16px;z-index:3200}
      .rf-ai-panel{position:fixed;top:0;right:0;height:100vh;width:min(420px,92vw);display:none;flex-direction:column;z-index:3100;border-left:1px solid rgba(255,255,255,.14);background:rgba(8,12,26,.96);backdrop-filter:blur(8px)}
      .rf-ai-panel.open{display:flex}
      .rf-ai-head{display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid rgba(255,255,255,.14)}
      .rf-ai-body{padding:12px;display:flex;flex-direction:column;gap:8px;overflow:auto;flex:1}
      .rf-ai-out{white-space:pre-wrap;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px;min-height:140px;background:rgba(255,255,255,.03)}
      .rf-ai-body textarea{min-height:100px;resize:vertical}
      @media(max-width:900px){body.${AI_CLASS}{padding-right:0}.rf-ai-panel{width:100vw;max-width:100vw}}
    `;
    document.head.appendChild(style);
  }

  function getSupabaseClient(){
    if (window.supabaseClient) return window.supabaseClient;
    if (window.getSupabaseClient) return window.getSupabaseClient();
    return null;
  }



  async function requestAI(question){
    const sb = getSupabaseClient();
    if(!sb) return { ok:false, status:0, data:{ error: 'Auth client unavailable.' } };

    const { data:{ session } } = await sb.auth.getSession();
    if(!session){
      return { ok:false, status:401, data:{ error: 'Please log in again.' } };
    }

    const res = await fetch('/api/ai', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${session.access_token}`},
      body: JSON.stringify({ question, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    });

    const data = await res.json().catch(()=>({}));
    return { ok: res.ok, status: res.status, data };
  }

  window.rfRequestAI = requestAI;

  function buildUi(){
    if (document.getElementById('rfAiPanel')) return;
    const fab = document.createElement('button');
    fab.className = 'btn rf-ai-fab';
    fab.id = 'rfAiFab';
    fab.type = 'button';
    fab.textContent = '🤖 AI';

    const panel = document.createElement('aside');
    panel.className = 'rf-ai-panel';
    panel.id = 'rfAiPanel';
    panel.innerHTML = `
      <div class="rf-ai-head"><strong>AI Tutor</strong><button class="btn" type="button" id="rfAiClose">Close</button></div>
      <div class="rf-ai-body">
        <textarea id="rfAiInput" placeholder="Ask anything about your revision..."></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" type="button" id="rfAiAsk">Ask AI</button><button class="btn" type="button" id="rfAiClear">Clear</button></div>
        <div id="rfAiOut" class="rf-ai-out">Your explanation will appear here.</div>
      </div>`;

    document.body.appendChild(panel);
    document.body.appendChild(fab);

    const open = ()=>{panel.classList.add('open'); document.body.classList.add(AI_CLASS);};
    const close = ()=>{panel.classList.remove('open'); document.body.classList.remove(AI_CLASS);};
    fab.addEventListener('click', open);
    panel.querySelector('#rfAiClose').addEventListener('click', close);
    panel.querySelector('#rfAiClear').addEventListener('click', ()=>{
      panel.querySelector('#rfAiInput').value = '';
      panel.querySelector('#rfAiOut').textContent = 'Your explanation will appear here.';
    });
    document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });

    panel.querySelector('#rfAiAsk').addEventListener('click', async ()=>{
      const out = panel.querySelector('#rfAiOut');
      const input = panel.querySelector('#rfAiInput').value.trim();
      if (!input){ out.textContent = 'Type a question first.'; return; }
      out.textContent = 'Thinking...';
      try{
        const result = await requestAI(input);
        if (result.status === 401){ out.textContent = 'Session expired. Please log in again.'; return; }
        if (result.status === 429){ out.textContent = result.data?.error || 'Daily AI limit reached.'; return; }
        out.textContent = result.data?.reply || result.data?.error || 'Something went wrong.';
      }catch(err){
        console.error('AI sidebar error:', err);
        out.textContent = 'Network error. Please try again.';
      }
    });
  }

  function init(){
    ensureStyles();
    buildUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

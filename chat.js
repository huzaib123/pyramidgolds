/* Pyramid Golds chat widget. Talks to the Cloudflare Worker in /backend.
   Include with: <script src="chat.js" data-api="https://<worker>.workers.dev" defer></script>
   With no data-api set, the widget stays hidden. */
(function () {
  const script = document.currentScript;
  const API = (script && script.dataset.api || '').replace(/\/$/, '');
  if (!API) return;

  const WA = 'https://wa.me/918082556365';
  const GREETING = 'Welcome to Pyramid Golds. How may I assist you today? I can help with MMTC-PAMP bars, biscuits and coins, our jewellery, buy-back, or a live quote.';
  const POLL_MS = 4000, POLL_MAX_MS = 200000;

  let sessionId;
  try { sessionId = sessionStorage.getItem('pg-chat-sid'); } catch (e) {}
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    try { sessionStorage.setItem('pg-chat-sid', sessionId); } catch (e) {}
  }
  const history = [];
  let busy = false;

  const css = `
  #pgc-btn{position:fixed;right:24px;bottom:24px;z-index:9000;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#c9a84c,#e8c97a);color:#080808;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 36px rgba(201,168,76,.35);transition:transform .25s cubic-bezier(.16,1,.3,1)}
  #pgc-btn:hover{transform:translateY(-3px) scale(1.04)}
  #pgc-btn svg{width:26px;height:26px}
  #pgc-panel{position:fixed;right:24px;bottom:96px;z-index:9000;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100dvh - 128px));display:flex;flex-direction:column;background:#0f0f0f;border:1px solid rgba(201,168,76,.25);border-radius:1rem;box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;opacity:0;transform:translateY(16px);pointer-events:none;transition:opacity .3s,transform .4s cubic-bezier(.16,1,.3,1);font-family:"Satoshi","Inter",sans-serif}
  #pgc-panel.open{opacity:1;transform:none;pointer-events:auto}
  .pgc-head{padding:1rem 1.25rem;border-bottom:1px solid rgba(201,168,76,.13);display:flex;align-items:center;justify-content:space-between;background:#161616}
  .pgc-title{font-family:"Cabinet Grotesk",sans-serif;font-weight:900;font-size:1rem;letter-spacing:-.02em;background:linear-gradient(135deg,#c9a84c,#e8c97a);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .pgc-sub{font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#8a8478;margin-top:2px}
  .pgc-x{color:#8a8478;font-size:1.4rem;line-height:1;padding:4px 8px}
  .pgc-x:hover{color:#f0ece3}
  .pgc-log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.6rem;overscroll-behavior:contain}
  .pgc-m{max-width:85%;padding:.65rem .9rem;border-radius:.9rem;font-size:.85rem;line-height:1.55;white-space:pre-wrap;word-wrap:break-word}
  .pgc-bot{align-self:flex-start;background:#1e1e1e;color:#f0ece3;border:1px solid rgba(201,168,76,.13);border-bottom-left-radius:.25rem}
  .pgc-me{align-self:flex-end;background:linear-gradient(135deg,#c9a84c,#e8c97a);color:#080808;font-weight:500;border-bottom-right-radius:.25rem}
  .pgc-typing{align-self:flex-start;color:#8a8478;font-size:.75rem;padding:.25rem .5rem}
  .pgc-form{display:flex;gap:.5rem;padding:.75rem;border-top:1px solid rgba(201,168,76,.13);background:#161616}
  .pgc-in{flex:1;background:#0f0f0f;border:1px solid rgba(201,168,76,.2);border-radius:999px;padding:.65rem 1rem;color:#f0ece3;font:inherit;font-size:.85rem;outline:none}
  .pgc-in:focus{border-color:#c9a84c}
  .pgc-send{background:linear-gradient(135deg,#c9a84c,#e8c97a);color:#080808;border-radius:999px;padding:0 1.1rem;font-weight:800;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase}
  .pgc-send:disabled{opacity:.5}
  .pgc-note{font-size:.62rem;color:#8a8478;padding:0 1rem .7rem;background:#161616;line-height:1.5}
  .pgc-note a{color:#c9a84c}
  @media(max-width:560px){#pgc-btn{right:16px;bottom:16px}#pgc-panel{right:16px;bottom:88px}}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'pgc-btn';
  btn.setAttribute('aria-label', 'Chat with Pyramid Golds');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  const panel = document.createElement('div');
  panel.id = 'pgc-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Pyramid Golds assistant');
  panel.innerHTML =
    '<div class="pgc-head"><div><div class="pgc-title">PYRAMID GOLDS</div><div class="pgc-sub">Executive Assistant</div></div><button class="pgc-x" aria-label="Close chat">&times;</button></div>' +
    '<div class="pgc-log" data-lenis-prevent aria-live="polite"></div>' +
    '<form class="pgc-form"><input class="pgc-in" placeholder="Type your message..." maxlength="1000" aria-label="Your message"><button class="pgc-send" type="submit">Send</button></form>' +
    '<div class="pgc-note">If you share your number or email, Pyramid Golds will use it only to contact you about your enquiry. Prefer a person? <a href="' + WA + '" target="_blank" rel="noopener">WhatsApp us</a>.</div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);
  const log = panel.querySelector('.pgc-log');
  const form = panel.querySelector('.pgc-form');
  const input = panel.querySelector('.pgc-in');
  const send = panel.querySelector('.pgc-send');

  function add(text, who) {
    const el = document.createElement('div');
    el.className = 'pgc-m ' + (who === 'me' ? 'pgc-me' : 'pgc-bot');
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function typing(on) {
    let t = log.querySelector('.pgc-typing');
    if (on && !t) { t = document.createElement('div'); t.className = 'pgc-typing'; t.textContent = 'Typing...'; log.appendChild(t); log.scrollTop = log.scrollHeight; }
    if (!on && t) t.remove();
  }
  function setBusy(b) { busy = b; send.disabled = b; }

  function toggle(open) {
    panel.classList.toggle('open', open);
    if (open && !log.children.length) { add(GREETING, 'bot'); history.push({ role: 'assistant', content: GREETING }); }
    if (open) setTimeout(() => input.focus(), 150);
  }
  btn.addEventListener('click', () => toggle(!panel.classList.contains('open')));
  panel.querySelector('.pgc-x').addEventListener('click', () => toggle(false));

  async function pollPing(pingId) {
    const started = Date.now();
    while (Date.now() - started < POLL_MAX_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      try {
        const res = await fetch(API + '/ping/' + encodeURIComponent(pingId));
        const data = await res.json();
        if (data.status && data.status !== 'pending') return data.reply;
      } catch (e) {}
    }
    return 'The owner could not respond just now. Please share your WhatsApp number and our team will contact you shortly.';
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    add(text, 'me');
    history.push({ role: 'user', content: text });
    setBusy(true);
    typing(true);
    try {
      const res = await fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, messages: history.slice(-20) }),
      });
      const data = await res.json();
      typing(false);
      const reply = data.reply || 'Please message us on WhatsApp at +91 80825 56365 and our team will assist you.';
      add(reply, 'bot');
      history.push({ role: 'assistant', content: reply });
      if (data.pingId) {
        typing(true);
        const answer = await pollPing(data.pingId);
        typing(false);
        add(answer, 'bot');
        history.push({ role: 'assistant', content: answer });
      }
    } catch (err) {
      typing(false);
      add('Sorry, I could not connect just now. Please message us on WhatsApp at +91 80825 56365.', 'bot');
    }
    setBusy(false);
    input.focus();
  });
})();

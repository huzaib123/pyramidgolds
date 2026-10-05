// Pyramid Golds chat backend (Cloudflare Worker).
//   POST /chat              customer chat turn -> assistant reply (+ pingId when the owner was pinged)
//   GET  /ping/:id          poll an owner ping: pending | answered | timeout
//   GET  /whatsapp/webhook  Meta webhook verification
//   POST /whatsapp/webhook  owner's WhatsApp replies
// State (pings, rate limits) lives in the STATE KV namespace.

import { SYSTEM_PROMPT, TOOLS, OWNER_ANSWERS } from './prompt.js';

const MAX_HISTORY = 20;
const MAX_MSG_CHARS = 1000;
const CHAT_LIMIT_PER_HOUR = 40;
const PING_LIMIT_PER_HOUR = 3;
const PING_TEXT = 'Please give me a brief moment while I check the floor for you...';
const PRICE_REPLY = 'Because live market prices fluctuate, we provide exact, locked-in quotes directly to our clients. Please share your name and your WhatsApp number or Email address, and our management team will contact you immediately with the best current price.';
const FALLBACK_REPLY = 'I am sorry, I could not process that just now. Please message us on WhatsApp at +91 80825 56365 and our team will assist you.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/chat' && request.method === 'POST') return json(await handleChat(request, env), 200, cors);
      if (url.pathname.startsWith('/ping/') && request.method === 'GET') return json(await handlePoll(url.pathname.slice(6), env), 200, cors);
      if (url.pathname === '/whatsapp/webhook' && request.method === 'GET') return verifyWebhook(url, env);
      if (url.pathname === '/whatsapp/webhook' && request.method === 'POST') return handleWebhook(request, env);
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ reply: FALLBACK_REPLY }, 200, cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- chat ----------

async function handleChat(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await underLimit(env, `rl:chat:${ip}`, CHAT_LIMIT_PER_HOUR))) {
    return { reply: 'You have sent a lot of messages in a short time. Please message us on WhatsApp at +91 80825 56365 and our team will assist you.' };
  }

  const body = await request.json().catch(() => null);
  const sessionId = cleanId(body?.sessionId);
  if (!sessionId || !Array.isArray(body?.messages)) throw new HttpError(400, 'sessionId and messages required');

  const history = body.messages
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!history.length || history.at(-1).role !== 'user') throw new HttpError(400, 'last message must be from the user');

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  let pingId = null;

  for (let round = 0; round < 3; round++) {
    const choice = await callOpenAI(env, messages);
    const msg = choice.message;
    if (!msg.tool_calls?.length) {
      if (pingId) return { reply: PING_TEXT, pingId };
      return { reply: guardReply(msg.content || '') };
    }
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      let result;
      if (call.function.name === 'log_lead') result = await logLead(env, args);
      else if (call.function.name === 'notify_owner') {
        result = await notifyOwner(env, { ip, sessionId, summary: args.summary });
        if (result.pingId) pingId = result.pingId;
      } else result = { ok: false, error: 'unknown tool' };
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ...result, pingId: undefined }) });
    }
  }
  return pingId ? { reply: PING_TEXT, pingId } : { reply: FALLBACK_REPLY };
}

async function callOpenAI(env, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      tools: TOOLS,
      temperature: 0.3,
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0];
}

// The prompt forbids prices; this catches a reply that slips one through anyway.
const PRICE_PATTERN = /(₹|\brs\.?\s?\d|\binr\s?\d|\d[\d,.]*\s?(\/-|rupees|lakh|per\s?(gram|gm|g\b|tola|10\s?g)))/i;
export function guardReply(text) {
  if (PRICE_PATTERN.test(text)) return PRICE_REPLY;
  return text.trim() || FALLBACK_REPLY;
}

// ---------- leads -> Google Sheet (via Apps Script) ----------

const PHONE = /^\+?[\d\s()-]{7,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function logLead(env, { name = '', contact = '', inquiry = '' }) {
  contact = String(contact).trim().slice(0, 80);
  const digits = contact.replace(/\D/g, '');
  if (!(EMAIL.test(contact) || (PHONE.test(contact) && digits.length >= 7 && digits.length <= 15))) {
    return { ok: false, error: 'Contact is not a valid phone number or email. Ask the customer to re-check it.' };
  }
  const row = [
    new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    String(name).trim().slice(0, 80),
    contact,
    String(inquiry).trim().slice(0, 200),
    'Pending',
  ];
  // The sheet's own Apps Script (backend/apps-script.gs) appends the row; it needs no Google Cloud project.
  const res = await fetch(env.SHEET_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ secret: env.SHEET_WEBHOOK_SECRET, row }),
    redirect: 'follow',
  });
  const out = res.ok ? await res.json().catch(() => null) : null;
  if (!out?.ok) {
    console.error('Sheet append failed', res.status, out);
    return { ok: false, error: 'Could not forward right now. Ask the customer to also message +91 80825 56365 on WhatsApp.' };
  }
  return { ok: true };
}

// ---------- owner ping -> WhatsApp ----------

export function storeOpen(env, now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const hour = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  const open = Number(env.OPEN_HOUR ?? 10), close = Number(env.CLOSE_HOUR ?? 21);
  return hour >= open && hour < close;
}

async function notifyOwner(env, { ip, sessionId, summary = '' }) {
  if (!storeOpen(env)) {
    return { ok: false, error: `The store is closed now (open ${env.OPEN_HOUR ?? 10}:00 to ${env.CLOSE_HOUR ?? 21}:00 IST). Offer to have the team contact the customer.` };
  }
  if (await env.STATE.get(`pingsess:${sessionId}`)) {
    return { ok: false, error: 'The owner was already checked in this chat. Offer to have the team contact the customer.' };
  }
  if (!(await underLimit(env, `rl:ping:${ip}`, PING_LIMIT_PER_HOUR))) {
    return { ok: false, error: 'The owner cannot be reached right now. Offer to have the team contact the customer.' };
  }

  const pingId = crypto.randomUUID();
  const text = (String(summary).replace(/\s+/g, ' ').trim() || 'A website visitor wants to visit now').slice(0, 200);
  const send = components => fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: env.WA_OWNER_NUMBER,
      type: 'template',
      template: { name: env.WA_TEMPLATE || 'owner_floor_check', language: { code: env.WA_TEMPLATE_LANG || 'en' }, components },
    }),
  });
  let res = await send([{ type: 'body', parameters: [{ type: 'text', text }] }]);
  // A template body without {{1}} rejects the parameter; send it plain rather than miss the ping.
  if (res.status === 400) res = await send([]);
  if (!res.ok) {
    console.error('WhatsApp send failed', res.status, await res.text());
    return { ok: false, error: 'The owner cannot be reached right now. Offer to have the team contact the customer.' };
  }
  const wamid = (await res.json()).messages?.[0]?.id;
  const ttl = 3600;
  await env.STATE.put(`ping:${pingId}`, JSON.stringify({ status: 'pending', created: Date.now() }), { expirationTtl: ttl });
  if (wamid) await env.STATE.put(`wamid:${wamid}`, pingId, { expirationTtl: ttl });
  await env.STATE.put('ping:latest', pingId, { expirationTtl: ttl });
  await env.STATE.put(`pingsess:${sessionId}`, pingId, { expirationTtl: 86400 });
  return { ok: true, pingId };
}

async function handlePoll(id, env) {
  const pingId = cleanId(id);
  const raw = pingId && await env.STATE.get(`ping:${pingId}`);
  if (!raw) return { status: 'timeout', reply: OWNER_ANSWERS.timeout };
  const ping = JSON.parse(raw);
  if (ping.status === 'answered') return { status: 'answered', reply: ping.reply };
  if (Date.now() - ping.created > Number(env.PING_TIMEOUT_SEC || 180) * 1000) return { status: 'timeout', reply: OWNER_ANSWERS.timeout };
  return { status: 'pending' };
}

function verifyWebhook(url, env) {
  const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === env.WA_VERIFY_TOKEN;
  return new Response(ok ? url.searchParams.get('hub.challenge') : 'forbidden', { status: ok ? 200 : 403 });
}

async function handleWebhook(request, env) {
  const raw = await request.text();
  if (!(await validSignature(raw, request.headers.get('X-Hub-Signature-256'), env.WA_APP_SECRET))) {
    return new Response('bad signature', { status: 401 });
  }
  const payload = JSON.parse(raw);
  const owner = String(env.WA_OWNER_NUMBER).replace(/\D/g, '');
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        if (String(m.from).replace(/\D/g, '') !== owner) continue; // only the owner can answer pings
        const pingId = (m.context?.id && await env.STATE.get(`wamid:${m.context.id}`)) || await env.STATE.get('ping:latest');
        if (!pingId) continue;
        const reply = ownerReply(m);
        if (!reply) continue;
        const prev = JSON.parse(await env.STATE.get(`ping:${pingId}`) || 'null');
        if (!prev || prev.status === 'answered') continue;
        await env.STATE.put(`ping:${pingId}`, JSON.stringify({ ...prev, status: 'answered', reply }), { expirationTtl: 3600 });
      }
    }
  }
  return new Response('ok');
}

// Maps the owner's WhatsApp reply to what the customer sees.
export function ownerReply(m) {
  const pressed = (m.button?.payload || m.button?.text || m.interactive?.button_reply?.title || '').toLowerCase();
  if (pressed) {
    // Buttons may be in English or Kashmiri ("Aa vanas peth hez chus" / "Oour hez chus" / "Busy hez chus").
    if (pressed.includes('busy')) return OWNER_ANSWERS.busy;
    if (pressed.includes('here') || pressed.includes('vanas')) return OWNER_ANSWERS.here;
    if (pressed.includes('later') || pressed.includes('oour')) return OWNER_ANSWERS.later;
  }
  const text = m.text?.body?.trim();
  if (text) return `Message from the owner: "${text.slice(0, 500)}"`;
  return null;
}

async function validSignature(body, header, secret) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const expected = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---------- helpers ----------

async function underLimit(env, key, max) {
  const bucket = `${key}:${Math.floor(Date.now() / 3600000)}`;
  const count = Number(await env.STATE.get(bucket) || 0);
  if (count >= max) return false;
  await env.STATE.put(bucket, String(count + 1), { expirationTtl: 3700 });
  return true;
}

function cleanId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://pyramidgolds.in').split(',').map(s => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

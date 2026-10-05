// Run with: cd backend && node --test
// Exercises the Worker end to end with fake OpenAI, WhatsApp, Apps Script and KV.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { guardReply, ownerReply, storeOpen, Pings } from '../src/worker.js';
import { OWNER_ANSWERS } from '../src/prompt.js';

function kv() {
  const m = new Map();
  return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}

let env, calls, openaiQueue;
beforeEach(() => {
  calls = [];
  openaiQueue = [];
  env = {
    STATE: kv(), OPENAI_API_KEY: 'sk-test', WA_TOKEN: 'wa', WA_PHONE_NUMBER_ID: '123', WA_OWNER_NUMBER: '60148927013',
    WA_VERIFY_TOKEN: 'verify', WA_APP_SECRET: 'secret', 
    SHEET_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec', SHEET_WEBHOOK_SECRET: 'shh', OPEN_HOUR: '0', CLOSE_HOUR: '24',
  };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('api.openai.com')) {
      const next = openaiQueue.shift();
      return Response.json({ choices: [{ message: next }] });
    }
    if (String(url).includes('script.google.com')) return Response.json({ ok: true });
    if (String(url).includes('graph.facebook.com')) return Response.json({ messages: [{ id: 'wamid.ABC' }] });
    throw new Error('unexpected fetch ' + url);
  };
});

const chat = (messages, sessionId = 'session-1234') =>
  worker.fetch(new Request('https://w.dev/chat', { method: 'POST', headers: { 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ sessionId, messages }) }), env).then(r => r.json());
const toolCall = (name, args) => ({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('plain answer passes through', async () => {
  openaiQueue.push({ content: 'Yes, 10g is currently available in stock in 24K 999.9 certified purity.' });
  const r = await chat([{ role: 'user', content: 'Do you have 10g?' }]);
  assert.match(r.reply, /available in stock/);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.messages[0].role, 'system');
  assert.deepEqual(sent.tools.map(t => t.function.name), ['log_lead', 'notify_owner']);
});

test('a price that slips through is replaced', async () => {
  openaiQueue.push({ content: 'Today it is ₹7,200 per gram.' });
  const r = await chat([{ role: 'user', content: 'rate?' }]);
  assert.match(r.reply, /locked-in quotes/);
  assert.equal(guardReply('We buy back 50 g bars.'), 'We buy back 50 g bars.');
  assert.match(guardReply('About Rs 72000 for 10 g'), /locked-in/);
});

test('lead is sent to the sheet script with the secret', async () => {
  openaiQueue.push(toolCall('log_lead', { name: 'Aamir', contact: '+91 98765 43210', inquiry: '50g bar - price' }));
  openaiQueue.push({ content: 'I have securely forwarded your request to our team.' });
  const r = await chat([{ role: 'user', content: 'Aamir, +91 98765 43210' }]);
  assert.match(r.reply, /securely forwarded/);
  const sheet = calls.find(c => c.url.includes('script.google.com'));
  const body = JSON.parse(sheet.init.body);
  assert.equal(body.secret, 'shh');
  const row = body.row;
  assert.deepEqual(row.slice(1), ['Aamir', '+91 98765 43210', '50g bar - price', 'Pending']);
});

test('invalid contact is not logged', async () => {
  openaiQueue.push(toolCall('log_lead', { contact: 'call me', inquiry: 'x' }));
  openaiQueue.push({ content: 'Could you re-check your number?' });
  await chat([{ role: 'user', content: 'call me' }]);
  assert.ok(!calls.some(c => c.url.includes('script.google.com')));
});

test('owner ping: template sent, button reply reaches the customer', async () => {
  openaiQueue.push(toolCall('notify_owner', { summary: 'Wants to visit now' }));
  openaiQueue.push({ content: 'One moment.' });
  const r = await chat([{ role: 'user', content: 'Is the owner there?' }]);
  assert.equal(r.reply, 'Please give me a brief moment while I check the floor for you...');
  assert.ok(r.pingId);
  const wa = JSON.parse(calls.find(c => c.url.includes('graph.facebook.com')).init.body);
  assert.equal(wa.to, '60148927013');
  assert.equal(wa.type, 'template');

  let poll = await worker.fetch(new Request(`https://w.dev/ping/${r.pingId}`), env).then(x => x.json());
  assert.equal(poll.status, 'pending');

  const hook = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '60148927013', type: 'button', context: { id: 'wamid.ABC' }, button: { text: 'Here now', payload: 'Here now' } }] } }] }] });
  const sig = 'sha256=' + createHmac('sha256', 'secret').update(hook).digest('hex');
  const res = await worker.fetch(new Request('https://w.dev/whatsapp/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': sig }, body: hook }), env);
  assert.equal(res.status, 200);
  poll = await worker.fetch(new Request(`https://w.dev/ping/${r.pingId}`), env).then(x => x.json());
  assert.deepEqual(poll, { status: 'answered', reply: OWNER_ANSWERS.here });
});

test('webhook rejects bad signatures and strangers', async () => {
  const hook = JSON.stringify({ entry: [] });
  const res = await worker.fetch(new Request('https://w.dev/whatsapp/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=00' }, body: hook }), env);
  assert.equal(res.status, 401);
  assert.equal(ownerReply({ text: { body: 'Back at 6' } }), 'Message from the owner: "Back at 6"');
  assert.equal(ownerReply({ button: { text: 'Aa vanas peth hez chus' } }), OWNER_ANSWERS.here);
  assert.equal(ownerReply({ button: { text: 'oour hez chus' } }), OWNER_ANSWERS.later);
  assert.equal(ownerReply({ button: { text: 'Busy hez chus' } }), OWNER_ANSWERS.busy);
});

test('ping is resent without the visitor line if the template has no {{1}}', async () => {
  const real = globalThis.fetch;
  let waCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com') && ++waCalls === 1) { calls.push({ url: String(url), init }); return new Response('{}', { status: 400 }); }
    return real(url, init);
  };
  openaiQueue.push(toolCall('notify_owner', { summary: 'visit' }));
  openaiQueue.push({ content: 'One moment.' });
  const r = await chat([{ role: 'user', content: 'Is the owner there?' }]);
  assert.ok(r.pingId);
  const sent = calls.filter(c => c.url.includes('graph.facebook.com')).map(c => JSON.parse(c.init.body).template.components);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], []);
});

test('second ping in the same chat is refused', async () => {
  for (let i = 0; i < 2; i++) {
    openaiQueue.push(toolCall('notify_owner', { summary: 'visit' }));
    openaiQueue.push({ content: 'Our team can contact you instead.' });
  }
  await chat([{ role: 'user', content: 'Is the owner there?' }]);
  const second = await chat([{ role: 'user', content: 'Is the owner there now?' }]);
  assert.equal(second.pingId, undefined);
  assert.equal(calls.filter(c => c.url.includes('graph.facebook.com')).length, 1);
});

test('ping times out after the configured wait', async () => {
  env.STATE.m.set('ping:abcdef12', JSON.stringify({ status: 'pending', created: Date.now() - 181000 }));
  const poll = await worker.fetch(new Request('https://w.dev/ping/abcdef12'), env).then(x => x.json());
  assert.equal(poll.status, 'timeout');
});

test('store hours are India time', () => {
  const e = { OPEN_HOUR: '10', CLOSE_HOUR: '20' };
  assert.equal(storeOpen(e, new Date('2026-10-04T05:00:00Z')), true);  // 10:30 IST
  assert.equal(storeOpen(e, new Date('2026-10-04T15:00:00Z')), false); // 20:30 IST
});

test('webhook verification handshake', async () => {
  const ok = await worker.fetch(new Request('https://w.dev/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42'), env);
  assert.equal(await ok.text(), '42');
});

test('Pings store keeps values until they expire', async () => {
  const m = new Map();
  const storage = { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => { [].concat(k).forEach(x => m.delete(x)); }, list: async () => m };
  const store = new Pings({ storage });
  const call = body => store.fetch(new Request('https://pings/', { method: 'POST', body: JSON.stringify(body) })).then(r => r.json());
  await call({ op: 'put', key: 'ping:a', value: 'x', ttl: 60 });
  assert.equal((await call({ op: 'get', key: 'ping:a' })).value, 'x');
  m.set('ping:b', { value: 'y', exp: Date.now() - 1 });
  assert.equal((await call({ op: 'get', key: 'ping:b' })).value, null);
});

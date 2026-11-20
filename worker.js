const ORIGIN = 'https://v6777091-maker.github.io';
const enc = new TextEncoder();

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function getUser(initData, env) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = await hmac(enc.encode('WebAppData'), env.BOT_TOKEN);
  if (hex(await hmac(secret, str)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (age > 86400) return null;
  try { return JSON.parse(p.get('user')).id; } catch { return null; }
}

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const getBal = async (env, id) => Number((await env.DB.get('bal:' + id)) || 0);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('RSH bot OK');

    if (url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const u = await request.json();
      if (u.pre_checkout_query) {
        await tg(env, 'answerPreCheckoutQuery', {
          pre_checkout_query_id: u.pre_checkout_query.id,
          ok: true,
        });
      }
      const pay = u.message && u.message.successful_payment;
      if (pay) {
        const seen = 'pay:' + pay.telegram_payment_charge_id;
        if (!(await env.DB.get(seen))) {
          const id = u.message.from.id;
          await env.DB.put(seen, '1');
          await env.DB.put('bal:' + id, String((await getBal(env, id)) + pay.total_amount));
        }
      }
      return new Response('ok');
    }

    let body = {};
    try { body = await request.json(); } catch {}
    const id = await getUser(body.initData, env);
    if (!id) return json({ error: 'auth' }, 401);

    if (url.pathname === '/balance') return json({ balance: await getBal(env, id) });

    if (url.pathname === '/invoice') {
      const amount = Math.floor(Number(body.amount));
      if (!(amount >= 1 && amount <= 10000)) return json({ error: 'amount' }, 400);
      const r = await tg(env, 'createInvoiceLink', {
        title: 'Пополнение баланса',
        description: `Пополнение на ${amount} Stars`,
        payload: `topup:${id}:${amount}`,
        currency: 'XTR',
        prices: [{ label: 'Stars', amount }],
      });
      return r.ok ? json({ link: r.result }) : json({ error: 'tg' }, 502);
    }

    return json({ error: 'not found' }, 404);
  },
};

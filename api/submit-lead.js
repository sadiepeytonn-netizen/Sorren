// Vercel serverless function: forwards website quote-form leads to Growbond.
// Every lead is sent to EVERY configured destination:
//   1. the main account: GROWBOND_ENDPOINT + GROWBOND_SECRET (optional if agents are set)
//   2. each agent: one JSON list in the AGENT_ROUTES environment variable, e.g.
//      [{"name":"Cedric","endpoint":"https://...","secret":"..."}, ...]
// All of these are read from Vercel environment variables. Never put them in this file.

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};

  // Honeypot: real visitors never see or fill this field. Bots do.
  // Pretend success so the bot moves on, but do not create a lead.
  if (clip(body.website, 200)) {
    res.status(200).json({ ok: true });
    return;
  }

  const firstName = clip(body.firstName, 80);
  const lastName = clip(body.lastName, 80);
  const phone = clip(body.phone, 30);
  const email = clip(body.email, 120);
  const source = clip(body.source || 'Website', 80);
  const baseNotes = clip(body.notes, 500);

  if (!firstName || !phone) {
    res.status(400).json({ error: 'Missing required fields (firstName, phone)' });
    return;
  }

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 11) {
    res.status(400).json({ error: 'Invalid phone number' });
    return;
  }

  // Build the list of places to send this lead.
  const targets = [];
  const isHttps = (u) => /^https:\/\//i.test(String(u || ''));
  if (process.env.GROWBOND_ENDPOINT && process.env.GROWBOND_SECRET) {
    targets.push({ name: 'main', endpoint: process.env.GROWBOND_ENDPOINT, secret: process.env.GROWBOND_SECRET });
  }
  if (process.env.AGENT_ROUTES) {
    try {
      const list = JSON.parse(process.env.AGENT_ROUTES);
      (Array.isArray(list) ? list : []).forEach((a, i) => {
        if (a && isHttps(a.endpoint) && a.secret) {
          targets.push({ name: clip(a.name || ('agent' + (i + 1)), 40), endpoint: a.endpoint, secret: a.secret });
        } else {
          console.error('AGENT_ROUTES entry skipped (needs https endpoint and secret):', clip(a && a.name, 40) || i);
        }
      });
    } catch (e) {
      console.error('AGENT_ROUTES is not valid JSON');
    }
  }

  if (!targets.length) {
    console.error('No lead destinations are configured');
    res.status(500).json({ error: 'Lead capture is not configured yet' });
    return;
  }

  // Attribution (which ad produced this lead) + consent record.
  const t = body.tracking && typeof body.tracking === 'object' ? body.tracking : {};
  const ip = clip((req.headers['x-forwarded-for'] || '').split(',')[0], 60);
  const ua = clip(req.headers['user-agent'], 200);
  const attrib = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbp', 'fbc', 'landing_page', 'referrer']
    .filter((k) => t[k])
    .map((k) => k + '=' + clip(t[k], 200))
    .join('; ');

  const notes = [
    baseNotes,
    attrib ? 'Attribution: ' + attrib : 'Attribution: none (direct or untracked)',
    'Consent: ' + (body.consentGiven ? 'YES' : 'NO') + ' at ' + new Date().toISOString() +
      ' | page=' + clip(body.pageUrl, 300) + ' | ip=' + ip + ' | ua=' + ua,
    body.consentText ? 'Consent text: ' + clip(body.consentText, 700) : '',
  ].filter(Boolean).join('\n');

  // Growbond's contact page does not show the webhook "notes" text, but it does
  // show Tags. So we also send the key facts as tags. If Growbond ever rejects
  // the tags, we retry once WITHOUT them so a lead is never lost.
  const mot = (baseNotes.match(/Motivation:\s*(.*?)\.\s*Budget:/i) || [])[1] || '';
  const bud = (baseNotes.match(/Budget:\s*(.*?)\.?\s*$/i) || [])[1] || '';
  const m = mot.toLowerCase();
  const goalLabel = !m ? '' : m.includes('income') ? 'income'
    : m.includes('final') ? 'final expenses'
    : (m.includes('mortgage') || m.includes('debt')) ? 'mortgage-debt'
    : m.includes('future') ? 'legacy'
    : 'exploring';
  const tag = (v) => String(v).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
  const tags = [
    t.utm_source ? 'src:' + t.utm_source : (t.gclid ? 'src:google' : (t.fbclid ? 'src:meta' : 'src:direct')),
    t.utm_campaign ? 'campaign:' + t.utm_campaign : '',
    t.utm_content ? 'ad:' + t.utm_content : '',
    t.landing_page ? 'page:' + String(t.landing_page).replace(/^\//, '').replace(/\.html$/, '') : '',
    goalLabel ? 'goal:' + goalLabel : '',
    bud ? 'budget:' + bud : '',
    body.consentGiven ? 'consent:yes' : '',
  ].filter(Boolean).map(tag).slice(0, 8);

  const payload = {
    first_name: firstName,
    last_name: lastName,
    phone: phone,
    email: email,
    source: source,
    notes: notes,
  };

  // Send to one destination. Tries with tags; if that destination rejects them (4xx),
  // retries once without tags so a lead is never lost. Each attempt has a time limit.
  const sendTo = async (target) => {
    const post = async (data) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      try {
        return await fetch(target.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-integration-secret': target.secret },
          body: JSON.stringify(data),
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      let r = await post({ ...payload, tags });
      let text = await r.text();
      if (!r.ok && r.status >= 400 && r.status < 500) {
        r = await post(payload);
        text = await r.text();
      }
      return { name: target.name, ok: r.ok, status: r.status, body: r.ok ? '' : String(text).slice(0, 200) };
    } catch (err) {
      return { name: target.name, ok: false, status: 0, body: String(err && err.message || err).slice(0, 200) };
    }
  };

  // Everyone gets every lead: send to all destinations at the same time.
  const results = await Promise.all(targets.map(sendTo));
  const okCount = results.filter((r) => r.ok).length;

  // Log which destinations accepted or rejected (no keys or lead details here).
  console.log('LEAD_DELIVERY', JSON.stringify({ sent: okCount, total: results.length, failed: results.filter((r) => !r.ok) }));

  if (!okCount) {
    console.error('Every destination rejected the lead');
    res.status(502).json({ error: 'Lead service rejected the request' });
    return;
  }

  // Backup copy of the consent/attribution record in the Vercel logs.
  console.log('LEAD_RECORD', JSON.stringify({ firstName, phone, email, source, tags, notes }));
  res.status(200).json({ ok: true });
};

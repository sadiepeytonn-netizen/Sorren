// Vercel serverless function: forwards website quote-form leads to Growbond.
// The endpoint and secret are read from Vercel environment variables
// (GROWBOND_ENDPOINT, GROWBOND_SECRET). Never put them in this file.

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

  const endpoint = process.env.GROWBOND_ENDPOINT;
  const secret = process.env.GROWBOND_SECRET;

  if (!endpoint || !secret) {
    console.error('Growbond env vars are not configured');
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

  const post = (data) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-integration-secret': secret,
    },
    body: JSON.stringify(data),
  });

  try {
    let growbondRes = await post({ ...payload, tags });
    let text = await growbondRes.text();

    if (!growbondRes.ok && growbondRes.status >= 400 && growbondRes.status < 500) {
      console.error('Growbond rejected lead with tags, retrying without:', growbondRes.status, text);
      growbondRes = await post(payload);
      text = await growbondRes.text();
    }

    if (!growbondRes.ok) {
      console.error('Growbond rejected the lead:', growbondRes.status, text);
      res.status(502).json({ error: 'Lead service rejected the request' });
      return;
    }

    // Backup copy of the consent/attribution record in the Vercel logs.
    console.log('LEAD_RECORD', JSON.stringify({ firstName, phone, email, source, tags, notes }));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Growbond request failed:', err);
    res.status(502).json({ error: 'Lead service unreachable' });
  }
};

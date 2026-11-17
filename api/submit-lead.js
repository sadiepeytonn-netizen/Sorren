// Vercel serverless function: forwards website quote-form leads to Growbond.
// Every lead is sent to EVERY configured destination:
//   1. the main account: GROWBOND_ENDPOINT + GROWBOND_SECRET (optional if agents are set)
//   2. each agent: one variable named AGENT_<NAME>, value {"endpoint":"https://...","secret":"..."}
//      (a single AGENT_ROUTES list of {name,endpoint,secret} objects also works)
// All of these are read from Vercel environment variables. Never put them in this file.
// Lead quality: obvious fake names, phone numbers and emails are rejected with HTTP 422
// (so nothing reaches an agent and the page does not fire the Meta "Lead" event).

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
    res.status(200).json({ ok: true, skipped: true });
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

  // ---- Lead quality checks (free, no outside service) ----
  const age = clip(body.age, 20);
  const state = clip(body.state, 40);
  const covering = clip(body.covering, 80);
  const flags = [];
  const reject = (field, message) => {
    console.log('LEAD_REJECTED', JSON.stringify({ field }));
    res.status(422).json({ error: 'invalid', field, message });
  };

  const normName = (s) => s.toLowerCase().replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').trim();
  const FAKE_NAMES = new Set([
    'john doe', 'jane doe', 'jon doe', 'mickey mouse', 'minnie mouse', 'donald duck', 'daffy duck', 'bugs bunny',
    'test test', 'first last', 'firstname lastname', 'your name', 'my name', 'no name', 'fake name', 'fake person',
    'name name', 'john q public', 'joe schmoe', 'joe blow', 'santa claus', 'spider man', 'harry potter',
    'darth vader', 'elon musk', 'donald trump', 'joe biden', 'barack obama',
  ]);
  const FAKE_WORD = /^(test|tester|testing|xxx+|aaa+|abc+|fake|none|null|na|n\/a|unknown|anonymous|nobody|noname|spam|scam|lol|idk|asdf\w*|qwer\w*|zxcv\w*|hjkl\w*|sdfg\w*|dfgh\w*)$/;
  const badNamePart = (p) => {
    const lower = normName(p);
    const w = lower.replace(/[ '-]/g, '');
    if (!w) return false;
    if (/appleseed/.test(w)) return true;                   // Johnny Appleseed
    if (/(.)\1{3,}/.test(w)) return true;                   // aaaa
    if (w.length >= 4 && !/[aeiouy]/.test(w)) return true;  // keyboard mash with no vowels
    return FAKE_WORD.test(w) || FAKE_WORD.test(lower);
  };
  if (/[0-9@]/.test(firstName + lastName)) {
    return reject('name', 'Please enter your real first and last name.');
  }
  if (firstName.replace(/[^A-Za-z]/g, '').length < 2) {
    return reject('name', 'Please enter your full first name.');
  }
  if (FAKE_NAMES.has(normName(firstName + ' ' + lastName)) || badNamePart(firstName) || (lastName && badNamePart(lastName))) {
    return reject('name', 'Please enter your real first and last name so an agent can reach the right person.');
  }

  // Phone: must have the shape of a real U.S. number.
  let ten = digits;
  if (digits.length === 11) {
    if (digits[0] !== '1') return reject('phone', 'Please enter a valid U.S. phone number.');
    ten = digits.slice(1);
  }
  const area = ten.slice(0, 3);
  const exch = ten.slice(3, 6);
  const line = ten.slice(6);
  let steps = 0;
  for (let i = 1; i < ten.length; i++) {
    const d = (Number(ten[i]) - Number(ten[i - 1]) + 10) % 10;
    if (d === 1 || d === 9) steps++;
  }
  const badPhone =
    !/^[2-9]/.test(area) ||                                // area code cannot start with 0 or 1
    /^[2-9]11$/.test(area) ||                              // 211, 311 ... 911
    area === '555' ||
    ['800', '833', '844', '855', '866', '877', '888'].includes(area) ||
    !/^[2-9]/.test(exch) ||                                // exchange cannot start with 0 or 1
    /^[2-9]11$/.test(exch) ||
    (exch === '555' && (/^01\d\d$/.test(line) || line === '1212')) ||  // fictional / directory numbers
    new Set(ten.split('')).size <= 2 ||                    // 5555555555, 1212121212
    steps >= 8;                                            // 1234567890, 9876543210
  if (badPhone) {
    return reject('phone', 'That phone number does not look valid. Please enter the best number to reach you.');
  }

  // Email (when given): real-looking address, not a placeholder, not a throwaway inbox.
  if (email) {
    const m = email.toLowerCase().match(/^([^@\s]+)@([^@\s]+\.[a-z]{2,})$/);
    if (!m) return reject('email', 'Please enter a valid email address.');
    const local = m[1];
    const dom = m[2];
    const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.com', 'test.org', 'domain.com',
      'email.com', 'none.com', 'noemail.com', 'nomail.com', 'no.com', 'fake.com', 'asdf.com', 'abc.com', 'a.com', 'xyz.com'];
    const PLACEHOLDER_LOCALS = /^(test|testing|asdf|asdfg|qwerty|noemail|none|no|nope|fake|abc|abcd|abc123|123|1234|name|email|spam|null|na|a|aa|aaa|xx|xxx)$/;
    if (PLACEHOLDER_DOMAINS.includes(dom) || PLACEHOLDER_LOCALS.test(local) || /appleseed/.test(local)) {
      return reject('email', 'Please enter your real email address.');
    }
    const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la',
      '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'tempr.email', 'yopmail.com', 'trashmail.com',
      'throwawaymail.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mintemail.com',
      'moakt.com', 'emailondeck.com', 'fakeinbox.com', 'spamgourmet.com', 'tmpmail.org', 'burnermail.io',
      'mohmal.com', 'inboxkitten.com', 'harakirimail.com', '33mail.com', 'mailcatch.com', 'tempinbox.com',
      'emailfake.com', 'mail7.io', 'dropmail.me', 'tempail.com', 'anonbox.net', 'crazymailing.com'];
    if (DISPOSABLE.includes(dom)) {
      return reject('email', 'Please use a regular email address (not a temporary inbox).');
    }
  }

  // Soft signal: accepted and tagged, but does not count as a Meta "Lead".
  if (state && /^no/i.test(state)) flags.push('non-fl');
  const qualLine = [
    age ? 'Age: ' + age : '',
    state ? 'Lives in Florida: ' + state : '',
    covering ? 'Protecting: ' + covering : '',
  ].filter(Boolean).join('. ');

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

  // One variable per agent: AGENT_<NAME> = {"endpoint":"https://...","secret":"..."}
  // Add a new agent by adding a new variable. (AGENT_ROUTES, above, still works too.)
  Object.keys(process.env)
    .filter((k) => /^AGENT_[A-Z0-9_]+$/i.test(k) && k.toUpperCase() !== 'AGENT_ROUTES')
    .forEach((k) => {
      try {
        const a = JSON.parse(process.env[k]);
        if (a && isHttps(a.endpoint) && a.secret) {
          targets.push({ name: clip(k.slice(6), 40), endpoint: a.endpoint, secret: a.secret });
        } else {
          console.error(k + ' skipped (needs https endpoint and secret)');
        }
      } catch (e) {
        console.error(k + ' is not valid JSON');
      }
    });

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
    qualLine ? 'Qualifiers: ' + qualLine + '.' : '',
    flags.length ? 'Flags: ' + flags.join(', ') : '',
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
    flags.includes('non-fl') ? 'state:non-fl' : '',
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
  res.status(200).json({ ok: true, flagged: flags.length > 0 });
};

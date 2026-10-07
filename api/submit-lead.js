// Vercel serverless function: forwards website quote-form leads to Growbond.
// The endpoint and secret are read from Vercel environment variables
// (GROWBOND_ENDPOINT, GROWBOND_SECRET). Never put them in this file.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  const phone = (body.phone || '').trim();
  const email = (body.email || '').trim();
  const source = (body.source || 'Website').trim();
  const notes = (body.notes || '').trim();

  if (!firstName || !phone) {
    res.status(400).json({ error: 'Missing required fields (firstName, phone)' });
    return;
  }

  const endpoint = process.env.GROWBOND_ENDPOINT;
  const secret = process.env.GROWBOND_SECRET;

  if (!endpoint || !secret) {
    console.error('Growbond env vars are not configured');
    res.status(500).json({ error: 'Lead capture is not configured yet' });
    return;
  }

  try {
    const growbondRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-integration-secret': secret,
      },
      body: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        email: email,
        source: source,
        notes: notes,
      }),
    });

    const text = await growbondRes.text();

    if (!growbondRes.ok) {
      console.error('Growbond rejected the lead:', growbondRes.status, text);
      res.status(502).json({ error: 'Lead service rejected the request' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Growbond request failed:', err);
    res.status(502).json({ error: 'Lead service unreachable' });
  }
};

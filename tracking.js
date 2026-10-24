/*
 * Sorren Insurance Group - shared tracking + attribution.
 *
 * 1. Captures UTM parameters and ad click IDs (gclid, fbclid, etc.) on the
 *    first page a visitor lands on and remembers them for the session, so the
 *    quote form can send them to the CRM with the lead.
 * 2. Loads the Meta Pixel and Google tag ONLY when an ID is filled in below.
 *    Until then this file does nothing visible and loads no third-party code.
 * 3. Exposes window.sorrenTrack.getData() and window.sorrenTrack.lead() for
 *    the quote forms.
 *
 * TO TURN ON TRACKING: paste the IDs from Meta Events Manager / Google Ads
 * into CONFIG below, commit, done. No other file needs to change.
 */
(function () {
  var CONFIG = {
    META_PIXEL_ID: '1119977227057061',            // e.g. '123456789012345'
    GOOGLE_TAG_ID: '',            // e.g. 'AW-123456789' (Google Ads) or 'G-XXXXXXX'
    GOOGLE_ADS_LEAD_SEND_TO: ''   // e.g. 'AW-123456789/AbCdEfGhIjKl' (conversion label)
  };

  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
              'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'];
  var STORE = 'sorren_attrib';

  function read() {
    try { return JSON.parse(sessionStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
  }
  function write(obj) {
    try { sessionStorage.setItem(STORE, JSON.stringify(obj)); } catch (e) {}
  }
  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Capture on landing (first touch wins for the session; new click IDs overwrite).
  var data = read();
  var params = new URLSearchParams(window.location.search);
  var hasNew = false;
  KEYS.forEach(function (k) {
    var v = params.get(k);
    if (v) { data[k] = v.slice(0, 200); hasNew = true; }
  });
  if (!data.landing_page) {
    data.landing_page = window.location.pathname;
    data.referrer = (document.referrer || '').slice(0, 300);
    hasNew = true;
  }
  if (hasNew) write(data);

  // ---- Meta Pixel (only if an ID is set) ----
  if (CONFIG.META_PIXEL_ID) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', CONFIG.META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  // ---- Google tag (only if an ID is set) ----
  if (CONFIG.GOOGLE_TAG_ID) {
    var gs = document.createElement('script');
    gs.async = true;
    gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(CONFIG.GOOGLE_TAG_ID);
    document.head.appendChild(gs);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', CONFIG.GOOGLE_TAG_ID);
  }

  window.sorrenTrack = {
    // Attribution + browser identifiers to send to the CRM with a lead.
    getData: function () {
      var d = read();
      var out = {};
      Object.keys(d).forEach(function (k) { out[k] = d[k]; });
      out.fbp = cookie('_fbp');
      out.fbc = cookie('_fbc');
      out.page = window.location.pathname;
      return out;
    },
    // Call once when a lead is successfully captured.
    lead: function () {
      try { if (window.fbq) window.fbq('track', 'Lead'); } catch (e) {}
      try {
        if (window.gtag && CONFIG.GOOGLE_ADS_LEAD_SEND_TO) {
          window.gtag('event', 'conversion', { send_to: CONFIG.GOOGLE_ADS_LEAD_SEND_TO });
        }
      } catch (e) {}
    }
  };
})();

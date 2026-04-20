/**
 * AGC Inventory — browser-side live refresh.
 *
 * Runs after each page-load and also every minute while the Atlanta shop
 * is open (08:00–18:00 US/Eastern). Outside the window, the interval
 * idles — the PHP render already painted the data on page-load, so the
 * page still shows *something* during off-hours.
 *
 * Talks to WP's admin-ajax.php. The WP side proxies to AGC Desk and
 * caches responses in a transient (TTL in agc-inventory.php), so a WP
 * instance serving 500 visitors in a minute still only generates one
 * upstream request.
 *
 * Ships no framework. Querying admin-ajax + swapping innerHTML is all
 * we need and keeps the plugin hot-reloadable on the shop's WP host
 * without a build step.
 */
(function () {
  if (typeof window === 'undefined' || !window.AGC_INV) return;

  var cfg = window.AGC_INV;

  function init() {
    var nodes = document.querySelectorAll('[data-agc-widget]');
    if (!nodes.length) return;
    nodes.forEach(function (el) {
      bind(el);
    });
  }

  function bind(root) {
    var widget = root.getAttribute('data-agc-widget');
    var metal = root.getAttribute('data-agc-metal') || '';
    var action =
      widget === 'live-inventory'
        ? 'agc_inv_live_inventory'
        : 'agc_inv_what_we_pay';

    schedule(function tick() {
      if (!inBusinessHours()) return;
      refresh(root, widget, action, metal);
    });
  }

  function schedule(fn) {
    // First tick on a small delay so the freshly-rendered DOM isn't
    // immediately replaced (the operator wants to see the initial paint).
    setTimeout(fn, 5000);
    setInterval(fn, cfg.refreshMs || 60000);
  }

  /**
   * Return true when it's 08:00–18:00 in US/Eastern. We use
   * Intl.DateTimeFormat with timeZone: 'America/New_York' so the check
   * works regardless of the visitor's locale.
   */
  function inBusinessHours() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false,
      }).formatToParts(new Date());
      var hour = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') hour = parseInt(parts[i].value, 10);
      }
      return hour >= (cfg.windowStart || 8) && hour < (cfg.windowEnd || 18);
    } catch (e) {
      // If the runtime doesn't support tz parts, always refresh —
      // erring on the side of fresh data for the operator.
      return true;
    }
  }

  function refresh(root, widget, action, metal) {
    root.classList.add('agc-inv-refreshing');
    var url =
      cfg.ajaxUrl +
      '?action=' +
      encodeURIComponent(action) +
      '&metal=' +
      encodeURIComponent(metal);
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('bad status');
        return r.json();
      })
      .then(function (json) {
        if (!json || !json.success) return;
        render(root, widget, json.data);
      })
      .catch(function () {
        // Swallow — keep whatever's on screen. The error banner only
        // fires on initial page load when there's literally no data.
      })
      .then(function () {
        root.classList.remove('agc-inv-refreshing');
      });
  }

  function render(root, widget, data) {
    var grouped = data.grouped || {};
    var html = '';
    var order = ['gold', 'silver', 'platinum', 'palladium', 'other'];
    for (var i = 0; i < order.length; i++) {
      var m = order[i];
      if (!grouped[m] || !grouped[m].length) continue;
      html += renderSection(widget, m, grouped[m]);
    }
    if (!html) {
      html =
        '<p class="agc-inv-empty">' +
        (widget === 'live-inventory'
          ? 'Nothing in stock right now. Call us at 404-236-9744.'
          : 'Pricing coming soon.') +
        '</p>';
    }
    html +=
      '<p class="agc-inv-footnote">' +
      (widget === 'live-inventory' ? 'Updated ' : 'Live prices — updated ') +
      '<span class="agc-inv-updated">' +
      escapeHtml(data.updated || '') +
      '</span>. Refreshes every minute between 8 AM – 6 PM Eastern. ' +
      (widget === 'live-inventory'
        ? 'Call <a href="tel:4042369744">404-236-9744</a> to confirm availability.'
        : 'Prices are indicative; call <a href="tel:4042369744">404-236-9744</a> to lock in.') +
      '</p>';
    root.innerHTML = html;
  }

  function renderSection(widget, metal, rows) {
    var heading = metal.charAt(0).toUpperCase() + metal.slice(1);
    var isLive = widget === 'live-inventory';
    var head = isLive
      ? '<th class="agc-inv-col-item">Item</th><th class="agc-inv-col-qty">Qty</th>'
      : '<th class="agc-inv-col-item">Item</th><th class="agc-inv-col-price">We pay</th>';
    var body = '';
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (isLive) {
        // Defensive: skip zero-stock rows even if the PHP layer ever
        // slips up. A "0" qty on a live-inventory page would read as
        // broken / misleading, never informative.
        var qty = parseInt(r.available, 10);
        if (!(qty > 0)) continue;
        body +=
          '<tr><td class="agc-inv-col-item"><span class="agc-inv-name">' +
          escapeHtml(r.name || '') +
          '</span></td><td class="agc-inv-col-qty">' +
          qty +
          '</td></tr>';
      } else {
        body +=
          '<tr><td class="agc-inv-col-item"><span class="agc-inv-name">' +
          escapeHtml(r.name || '') +
          '</span></td><td class="agc-inv-col-price">$' +
          formatMoney(r.buy_price) +
          '</td></tr>';
      }
    }
    return (
      '<section class="agc-inv-section agc-inv-section--' +
      escapeHtml(metal) +
      '"><h3 class="agc-inv-metal-heading">' +
      escapeHtml(heading) +
      '</h3><table class="agc-inv-table"><thead><tr>' +
      head +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></section>'
    );
  }

  function formatMoney(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

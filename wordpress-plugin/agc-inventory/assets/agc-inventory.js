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
   * Return true when the metals market is open AND we're inside one of
   * the two daily refresh windows, all in US/Eastern:
   *
   *   Day window:       08:00 – 17:00
   *   Overnight window: 18:00 – 07:00 (wraps midnight)
   *
   *   Gaps (NO refresh):   17:00 – 18:00  (COMEX daily break)
   *                        07:00 – 08:00  (pre-market quiet hour)
   *
   *   Weekend close:       Fri 17:00 – Sun 18:00  (market closed)
   *
   * Tracks CME Globex hours for precious-metals futures. The page
   * still renders during gaps/close — only the 60s poller pauses.
   */
  function inBusinessHours() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: 'numeric',
        hour12: false,
      }).formatToParts(new Date());
      var hour = 0;
      var weekday = '';
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'hour') hour = parseInt(parts[i].value, 10);
        if (parts[i].type === 'weekday') weekday = parts[i].value;
      }
      // Intl returns hour=24 at the exact start of the next day in some
      // runtimes; normalize so comparisons work.
      if (hour === 24) hour = 0;

      // Weekend close: Fri ≥17:00 through Sun <18:00
      if (weekday === 'Fri' && hour >= 17) return false;
      if (weekday === 'Sat') return false;
      if (weekday === 'Sun' && hour < 18) return false;

      // Daily gaps
      if (hour === 17) return false; // 17:00-17:59 (COMEX break)
      if (hour === 7) return false;  // 07:00-07:59 (pre-market quiet)

      return true;
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
    // Spot strip — prepended to the rebuilt HTML so it survives the
    // innerHTML swap below. Only rendered on What We Pay; Live Inventory
    // skips it entirely. When the API spot call fails, renderSpotStrip
    // returns an empty placeholder rather than leaving stale prices.
    var html =
      widget === 'what-we-pay' ? renderSpotStrip(data.spot || null) : '';
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
      '</span>. Refreshes every minute while the metals market is open (Sun 6 PM – Fri 5 PM Eastern, daily break 5–6 PM). ' +
      (widget === 'live-inventory'
        ? 'Call <a href="tel:4042369744">404-236-9744</a> to confirm availability.'
        : 'Prices are indicative; call <a href="tel:4042369744">404-236-9744</a> to schedule your appointment.') +
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

  /**
   * Four-metal spot strip. Mirrors the PHP renderer — same classnames
   * so the CSS layer knows only one structure. When spot is null (API
   * down / cold cache), renders an empty placeholder to reserve the
   * vertical space so the page doesn't jump on the next successful poll.
   */
  function renderSpotStrip(spot) {
    var metals = [
      { key: 'gold', label: 'Gold' },
      { key: 'silver', label: 'Silver' },
      { key: 'platinum', label: 'Platinum' },
      { key: 'palladium', label: 'Palladium' },
    ];
    if (!spot) {
      return '<div class="agc-inv-spot-strip" data-agc-spot="empty"></div>';
    }
    var change = spot.change && typeof spot.change === 'object' ? spot.change : {};
    var html = '<div class="agc-inv-spot-strip" data-agc-spot="ready">';
    for (var i = 0; i < metals.length; i++) {
      var m = metals[i];
      var raw = spot[m.key];
      var priceHtml =
        raw != null && isFinite(Number(raw)) ? '$' + formatMoney(raw) : '&mdash;';
      html +=
        '<div class="agc-inv-spot agc-inv-spot--' +
        m.key +
        '"><span class="agc-inv-spot-label">' +
        m.label +
        '</span><span class="agc-inv-spot-price" data-agc-spot-metal="' +
        m.key +
        '">' +
        priceHtml +
        '</span>';
      // ±change row — same logic as the PHP renderer so both paint the
      // same thing.
      var c = change[m.key];
      if (c && c.delta != null && c.percent != null) {
        var delta = Number(c.delta);
        var percent = Number(c.percent);
        if (isFinite(delta) && isFinite(percent)) {
          var dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
          var arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
          var sign = delta > 0 ? '+' : '';
          html +=
            '<span class="agc-inv-spot-change agc-inv-spot-change--' +
            dir +
            '"><span class="agc-inv-spot-change-arrow">' +
            arrow +
            '</span>' +
            escapeHtml(sign + formatMoney(delta) + ' (' + sign + percent.toFixed(2) + '%)') +
            '</span>';
        }
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
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

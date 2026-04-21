<?php
/**
 * Plugin Name:       AGC Inventory
 * Plugin URI:        https://agcdesk.com
 * Description:       Live inventory and "What We Pay" widgets for Atlanta
 *                    Gold & Coin, fed by the AGC Desk API. Elementor widgets
 *                    + shortcodes, auto-refreshing during shop hours.
 * Version:           2.2.0
 * Author:            Atlanta Gold and Coin
 * License:           Proprietary
 * Text Domain:       agc-inventory
 * Requires at least: 6.0
 * Requires PHP:      7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

/**
 * AGC Inventory v2.0.0
 * ──────────────────────────────────────────────────────────────────────────
 * Single-file plugin. v1 split Elementor widget classes into /includes/*.php
 * which was harder to debug on sandboxes (Playground, WP.com) because a
 * silent failure to load a sub-file would cause the main plugin to
 * "activate" but have no working hooks. All code now lives in this file.
 *
 * Architecture:
 *   1. PHP-side:   agc_inv_fetch() proxies to AGC Desk API with a WP
 *                  transient cache. Two shortcodes + two Elementor
 *                  widgets render the data server-side on first paint.
 *   2. Browser:    agc-inventory.js polls admin-ajax every 60s during
 *                  shop hours (8 AM – 6 PM ET) and swaps innerHTML.
 *   3. Theme:      agc-inventory.css — near-black navy base + primary
 *                  gold accents, Instrument Sans from Google Fonts.
 *                  Scoped under .agc-inv-wrap so it never bleeds into
 *                  the parent theme.
 *
 * Failure modes are visible, not silent:
 *   - API unreachable → renders a dark-navy error card ("Inventory is
 *     temporarily unavailable") with a retry hint, NOT a blank div.
 *   - Elementor missing → widgets skip registration but shortcodes
 *     still work.
 *   - Outbound HTTPS blocked (WP.com free, some sandboxes) → same
 *     error card, with a note in the settings page pointing to the
 *     "Test connection" button.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

define( 'AGC_INV_VERSION', '2.2.0' );
define( 'AGC_INV_DEFAULT_BASE', 'https://agc-api-production.up.railway.app/api/v1' );
// Server-side transient TTL. Short enough that a show_on_website toggle
// in AGC Desk appears on the shop's WP page within ~15s, long enough
// to absorb a burst of visitors without flooding the API.
define( 'AGC_INV_CACHE_TTL', 15 );
define( 'AGC_INV_WINDOW_START_HOUR', 8 );
define( 'AGC_INV_WINDOW_END_HOUR', 18 );

// ─── Options / Settings page ────────────────────────────────────────────────

function agc_inv_get_base() {
    $opt = get_option( 'agc_inv_base', '' );
    return $opt ? rtrim( $opt, '/' ) : AGC_INV_DEFAULT_BASE;
}

add_action( 'admin_menu', function () {
    add_options_page(
        'AGC Inventory',
        'AGC Inventory',
        'manage_options',
        'agc-inventory',
        'agc_inv_render_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting( 'agc_inv_settings', 'agc_inv_base', [
        'sanitize_callback' => 'esc_url_raw',
    ] );
} );

function agc_inv_render_settings_page() {
    ?>
    <div class="wrap">
        <h1>AGC Inventory Settings</h1>
        <p>
            Plugin version <strong><?php echo esc_html( AGC_INV_VERSION ); ?></strong>.
            If the front-end widgets show "temporarily unavailable", click
            <strong>Test connection</strong> below to diagnose.
        </p>

        <form method="post" action="options.php">
            <?php settings_fields( 'agc_inv_settings' ); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="agc_inv_base">AGC Desk API base</label></th>
                    <td>
                        <input type="url" name="agc_inv_base" id="agc_inv_base"
                            value="<?php echo esc_attr( get_option( 'agc_inv_base', '' ) ); ?>"
                            class="regular-text" placeholder="<?php echo esc_attr( AGC_INV_DEFAULT_BASE ); ?>" />
                        <p class="description">
                            Base URL of the AGC Desk API, including <code>/api/v1</code>.
                            Leave blank to use the default
                            (<code><?php echo esc_html( AGC_INV_DEFAULT_BASE ); ?></code>).
                            When the field is empty, the plugin follows whatever default
                            is compiled in — makes host migrations one-line changes.
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <h2>Shortcodes</h2>
        <pre><code>[agc_live_inventory]
[agc_what_we_pay]</code></pre>

        <h2>Elementor</h2>
        <p>Two widgets appear under <strong>AGC Desk</strong> in the editor:
            <em>AGC Live Inventory</em> and <em>AGC What We Pay</em>.</p>

        <h2>Diagnostics</h2>
        <p>
            <button type="button" class="button button-primary"
                onclick="agcInvTestConnection(this);">Test connection</button>
            <button type="button" class="button" style="margin-left: 8px;"
                onclick="agcInvFlushCache(this);">Flush cache now</button>
            <span id="agc-inv-diag-out" style="margin-left: 12px; font-family: monospace;"></span>
        </p>
        <script>
        function agcInvTestConnection(btn) {
            btn.disabled = true;
            var out = document.getElementById('agc-inv-diag-out');
            out.textContent = 'Pinging AGC Desk…';
            fetch(ajaxurl + '?action=agc_inv_diag', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (json) {
                    if (json && json.success) {
                        out.innerHTML = '<span style="color:#228B22">✓ '
                            + json.data.items_what_we_pay + ' prices · '
                            + json.data.items_in_stock + ' in-stock items · '
                            + 'base=' + json.data.base + '</span>';
                    } else {
                        out.innerHTML = '<span style="color:#a00">✗ '
                            + (json && json.data && json.data.message
                                ? json.data.message : 'Unknown error') + '</span>';
                    }
                })
                .catch(function (e) {
                    out.innerHTML = '<span style="color:#a00">✗ ' + e + '</span>';
                })
                .then(function () { btn.disabled = false; });
        }
        function agcInvFlushCache(btn) {
            btn.disabled = true;
            var out = document.getElementById('agc-inv-diag-out');
            out.textContent = 'Flushing…';
            fetch(ajaxurl + '?action=agc_inv_flush_cache', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (json) {
                    out.textContent = (json && json.success)
                        ? '✓ Cache flushed. Next page-load fetches fresh.'
                        : '✗ Failed';
                })
                .catch(function (e) {
                    out.textContent = '✗ ' + e;
                })
                .then(function () { btn.disabled = false; });
        }
        </script>
    </div>
    <?php
}

// ─── Cache flush (admin-only) ───────────────────────────────────────────────

add_action( 'wp_ajax_agc_inv_flush_cache', function () {
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_send_json_error( [ 'message' => 'forbidden' ], 403 );
    }
    delete_transient( 'agc_inv_' . md5( 'public/in-stock' ) );
    delete_transient( 'agc_inv_' . md5( 'public/what-we-pay' ) );
    wp_send_json_success( [ 'flushed' => true ] );
} );

// ─── Diagnostics endpoint ───────────────────────────────────────────────────

/**
 * Admin-only "is the API reachable?" check. Fetches both endpoints once,
 * reports the item counts and the URL it hit. Surfaces outbound-HTTPS
 * blocks (WP.com free, some sandboxes) as a clear error instead of a
 * silent blank widget.
 */
add_action( 'wp_ajax_agc_inv_diag', function () {
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_send_json_error( [ 'message' => 'forbidden' ], 403 );
    }
    $base     = agc_inv_get_base();
    $in_stock = agc_inv_fetch( 'public/in-stock', true );
    $what_pay = agc_inv_fetch( 'public/what-we-pay', true );
    if ( null === $in_stock && null === $what_pay ) {
        wp_send_json_error( [
            'message' => 'Could not reach AGC Desk at ' . $base
                . '. Check WordPress allows outbound HTTPS to this host.',
            'base'    => $base,
        ] );
    }
    wp_send_json_success( [
        'base'                 => $base,
        'items_what_we_pay'    => is_array( $what_pay ) && isset( $what_pay['items'] )
            ? count( $what_pay['items'] ) : 0,
        'items_in_stock'       => is_array( $in_stock ) ? count( $in_stock ) : 0,
    ] );
} );

// ─── Browser polling endpoints ──────────────────────────────────────────────

add_action( 'wp_ajax_agc_inv_live_inventory', 'agc_inv_ajax_live_inventory' );
add_action( 'wp_ajax_nopriv_agc_inv_live_inventory', 'agc_inv_ajax_live_inventory' );
add_action( 'wp_ajax_agc_inv_what_we_pay', 'agc_inv_ajax_what_we_pay' );
add_action( 'wp_ajax_nopriv_agc_inv_what_we_pay', 'agc_inv_ajax_what_we_pay' );

function agc_inv_ajax_live_inventory() {
    $metal = isset( $_GET['metal'] ) ? sanitize_text_field( wp_unslash( $_GET['metal'] ) ) : '';
    $items = agc_inv_fetch( 'public/in-stock' );
    if ( ! is_array( $items ) ) {
        wp_send_json_error( [ 'message' => 'unavailable' ], 502 );
    }
    $items = array_values( array_filter( $items, function ( $r ) {
        return isset( $r['available'] ) && intval( $r['available'] ) > 0;
    } ) );
    $items    = agc_inv_filter_by_metal( $items, $metal );
    $sections = agc_inv_group_by_display_category( $items );
    wp_send_json_success( [
        'sections' => $sections,
        'mode'     => 'live-inventory',
        'updated'  => current_time( 'g:i A' ),
    ] );
}

function agc_inv_ajax_what_we_pay() {
    $metal   = isset( $_GET['metal'] ) ? sanitize_text_field( wp_unslash( $_GET['metal'] ) ) : '';
    $payload = agc_inv_fetch( 'public/what-we-pay' );
    if ( ! is_array( $payload ) || ! isset( $payload['items'] ) ) {
        wp_send_json_error( [ 'message' => 'unavailable' ], 502 );
    }
    $items    = agc_inv_filter_by_metal( $payload['items'], $metal );
    $sections = agc_inv_group_by_display_category( $items );
    // Spot feed is a second endpoint — fetching it here so the JS poller
    // can refresh both the pay-list AND the top-of-widget spot strip in
    // a single roundtrip. Cached transiently same as the pay-list (15s),
    // and non-fatal: a null spot just hides the strip until the next tick.
    $spot = agc_inv_fetch( 'public/spot' );
    wp_send_json_success( [
        'sections' => $sections,
        'mode'     => 'what-we-pay',
        'updated'  => current_time( 'g:i A' ),
        'spot'     => is_array( $spot ) ? $spot : null,
    ] );
}

// ─── HTTP client w/ transient cache ─────────────────────────────────────────

/**
 * Fetch JSON from AGC Desk. Uses a WP transient so repeat page-loads
 * within AGC_INV_CACHE_TTL don't hit the API. Returns null on failure.
 *
 * @param string $path    Path relative to the API base (no leading slash).
 * @param bool   $bypass  If true, skip the transient cache (used by diag).
 */
function agc_inv_fetch( $path, $bypass = false ) {
    $cache_key = 'agc_inv_' . md5( $path );
    if ( ! $bypass ) {
        $cached = get_transient( $cache_key );
        if ( false !== $cached ) {
            return $cached;
        }
    }

    $url      = agc_inv_get_base() . '/' . ltrim( $path, '/' );
    $response = wp_remote_get( $url, [
        'timeout' => 8,
        'headers' => [ 'Accept' => 'application/json' ],
    ] );
    if ( is_wp_error( $response ) ) {
        return null;
    }
    $code = wp_remote_retrieve_response_code( $response );
    if ( $code < 200 || $code >= 300 ) {
        return null;
    }
    $body = wp_remote_retrieve_body( $response );
    $data = json_decode( $body, true );
    if ( null === $data ) {
        return null;
    }
    if ( ! $bypass ) {
        set_transient( $cache_key, $data, AGC_INV_CACHE_TTL );
    }
    return $data;
}

// ─── Asset enqueue ─────────────────────────────────────────────────────────

add_action( 'wp_enqueue_scripts', function () {
    wp_register_style(
        'agc-inv-font',
        'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap',
        [],
        AGC_INV_VERSION
    );
    wp_register_style(
        'agc-inv',
        plugins_url( 'assets/agc-inventory.css', __FILE__ ),
        [ 'agc-inv-font' ],
        AGC_INV_VERSION
    );
    wp_register_script(
        'agc-inv',
        plugins_url( 'assets/agc-inventory.js', __FILE__ ),
        [],
        AGC_INV_VERSION,
        true
    );
    wp_localize_script( 'agc-inv', 'AGC_INV', [
        'ajaxUrl'     => admin_url( 'admin-ajax.php' ),
        'refreshMs'   => 60 * 1000,
        'windowStart' => AGC_INV_WINDOW_START_HOUR,
        'windowEnd'   => AGC_INV_WINDOW_END_HOUR,
    ] );

    // Separate bundle for the buy-rates landing page. Registered here so
    // enqueue inside the shortcode render is a no-op if multiple blocks
    // appear on the same page. Inter font loaded independently because
    // the buy-rates design uses Inter (matching atlantagoldandcoin.com),
    // not the widget's Instrument Sans.
    wp_register_style(
        'agc-buy-font',
        'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
        [],
        AGC_INV_VERSION
    );
    wp_register_style(
        'agc-buy-rates',
        plugins_url( 'assets/agc-buy-rates.css', __FILE__ ),
        [ 'agc-buy-font' ],
        AGC_INV_VERSION
    );
    wp_register_script(
        'agc-buy-rates',
        plugins_url( 'assets/agc-buy-rates.js', __FILE__ ),
        [],
        AGC_INV_VERSION,
        true
    );
} );

// ─── Shortcodes ────────────────────────────────────────────────────────────

add_shortcode( 'agc_live_inventory', function ( $atts ) {
    $atts = shortcode_atts( [ 'metal' => '' ], $atts, 'agc_live_inventory' );
    return agc_inv_render_live_inventory( $atts );
} );

add_shortcode( 'agc_what_we_pay', function ( $atts ) {
    $atts = shortcode_atts( [ 'metal' => '' ], $atts, 'agc_what_we_pay' );
    return agc_inv_render_what_we_pay( $atts );
} );

/**
 * Full buy-rates landing-page layout: hero + explainer content + CTA +
 * right-side sliding drawer wrapping a Gravity Form. The drawer ONLY
 * opens when the "Schedule Appointment" CTA is clicked, so the form
 * is out of the way on first read but one tap away.
 *
 * Attributes:
 *   form_id    — Gravity Form id (default "2")
 *   show_pay   — include the [agc_what_we_pay] widget beneath the rates
 *                intro ("1" to render, default "0"). Skip if you insert
 *                the widget manually elsewhere on the page.
 */
add_shortcode( 'agc_buy_rates_page', function ( $atts ) {
    $atts = shortcode_atts(
        [
            'form_id'  => '2',
            'show_pay' => '0',
        ],
        $atts,
        'agc_buy_rates_page'
    );
    return agc_inv_render_buy_rates_page( $atts );
} );

// ─── Renderers ─────────────────────────────────────────────────────────────

function agc_inv_render_live_inventory( $atts ) {
    wp_enqueue_style( 'agc-inv' );
    wp_enqueue_script( 'agc-inv' );

    $items = agc_inv_fetch( 'public/in-stock' );
    if ( ! is_array( $items ) ) {
        return agc_inv_error_card( 'Live inventory is temporarily unavailable. This usually resolves within a minute.' );
    }
    $items = array_values( array_filter( $items, function ( $r ) {
        return isset( $r['available'] ) && intval( $r['available'] ) > 0;
    } ) );
    $items    = agc_inv_filter_by_metal( $items, $atts['metal'] );
    $sections = agc_inv_group_by_display_category( $items );

    ob_start();
    ?>
    <div class="agc-inv-wrap" data-agc-widget="live-inventory" data-agc-metal="<?php echo esc_attr( $atts['metal'] ); ?>">
        <?php echo agc_inv_render_toolbar( $sections, 'live-inventory' ); ?>
        <?php if ( empty( $items ) ): ?>
            <p class="agc-inv-empty">Nothing in stock right now. Check back later, or call us at 404-236-9744.</p>
        <?php endif; ?>
        <?php foreach ( $sections as $s ): ?>
            <section
                class="agc-inv-section agc-inv-section--<?php echo esc_attr( $s['id'] ); ?>"
                id="agc-section-<?php echo esc_attr( $s['id'] ); ?>">
                <h3 class="agc-inv-metal-heading"><?php echo esc_html( $s['label'] ); ?></h3>
                <table class="agc-inv-table">
                    <thead>
                        <tr>
                            <th class="agc-inv-col-item">Item</th>
                            <th class="agc-inv-col-qty">Qty</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ( $s['rows'] as $row ): ?>
                            <tr>
                                <td class="agc-inv-col-item">
                                    <span class="agc-inv-name"><?php echo esc_html( $row['name'] ); ?></span>
                                </td>
                                <td class="agc-inv-col-qty"><?php echo intval( $row['available'] ); ?></td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </section>
        <?php endforeach; ?>
        <p class="agc-inv-footnote">
            Updated <span class="agc-inv-updated"><?php echo esc_html( current_time( 'g:i A' ) ); ?></span>.
            Refreshes every minute while the metals market is open
            (Sun 6 PM &ndash; Fri 5 PM Eastern, daily break 5&ndash;6 PM). Call
            <a href="tel:4042369744">404-236-9744</a> to confirm availability.
        </p>
    </div>
    <?php
    return ob_get_clean();
}

function agc_inv_render_what_we_pay( $atts ) {
    wp_enqueue_style( 'agc-inv' );
    wp_enqueue_script( 'agc-inv' );

    $payload = agc_inv_fetch( 'public/what-we-pay' );
    if ( ! is_array( $payload ) || ! isset( $payload['items'] ) ) {
        return agc_inv_error_card( 'Live pricing is temporarily unavailable. This usually resolves within a minute.' );
    }
    $items    = $payload['items'];
    $items    = agc_inv_filter_by_metal( $items, $atts['metal'] );
    $sections = agc_inv_group_by_display_category( $items );
    // Spot strip data — hidden gracefully if the spot endpoint is down.
    $spot = agc_inv_fetch( 'public/spot' );

    ob_start();
    ?>
    <div class="agc-inv-wrap" data-agc-widget="what-we-pay" data-agc-metal="<?php echo esc_attr( $atts['metal'] ); ?>">
        <?php echo agc_inv_render_spot_strip( $spot ); ?>
        <?php echo agc_inv_render_toolbar( $sections, 'what-we-pay' ); ?>
        <?php if ( empty( $items ) ): ?>
            <p class="agc-inv-empty">Pricing coming soon.</p>
        <?php endif; ?>
        <?php foreach ( $sections as $s ): ?>
            <section
                class="agc-inv-section agc-inv-section--<?php echo esc_attr( $s['id'] ); ?>"
                id="agc-section-<?php echo esc_attr( $s['id'] ); ?>">
                <h3 class="agc-inv-metal-heading"><?php echo esc_html( $s['label'] ); ?></h3>
                <table class="agc-inv-table">
                    <thead>
                        <tr>
                            <th class="agc-inv-col-item">Item</th>
                            <th class="agc-inv-col-price">We pay</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ( $s['rows'] as $row ): ?>
                            <tr>
                                <td class="agc-inv-col-item">
                                    <span class="agc-inv-name"><?php echo esc_html( $row['name'] ); ?></span>
                                </td>
                                <td class="agc-inv-col-price">
                                    $<?php echo esc_html( number_format( floatval( $row['buy_price'] ), 2 ) ); ?>
                                </td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            </section>
        <?php endforeach; ?>
        <p class="agc-inv-footnote">
            Live prices &mdash; updated <span class="agc-inv-updated"><?php echo esc_html( current_time( 'g:i A' ) ); ?></span>.
            Refreshes every minute while the metals market is open
            (Sun 6 PM &ndash; Fri 5 PM Eastern, daily break 5&ndash;6 PM). Prices
            are indicative; call <a href="tel:4042369744">404-236-9744</a> to schedule your appointment.
        </p>
    </div>
    <?php
    return ob_get_clean();
}

/**
 * Four-metal spot strip rendered above the What We Pay widget. The JS
 * poller replaces this HTML in-place on every refresh via matching
 * classnames (.agc-inv-spot-strip + .agc-inv-spot-price per metal).
 *
 * Returns empty string when spot payload is missing or malformed so the
 * widget still paints instead of showing a broken "Loading..." placeholder.
 */
/**
 * Buy-rates landing page — hero, prose, CTA, and a right-side slide-in
 * drawer that wraps a Gravity Form. Enqueues the page-level stylesheet
 * and JS on demand (the widget-level assets are a separate bundle).
 *
 * The Gravity Form shortcode is expanded via do_shortcode() so WP's
 * Gravity Forms plugin renders it inside the drawer — no manual field
 * rebuild on our side.
 */
function agc_inv_render_buy_rates_page( $atts ) {
    wp_enqueue_style( 'agc-buy-rates' );
    wp_enqueue_script( 'agc-buy-rates' );
    // Widget stylesheet used by the inline [agc_what_we_pay] if show_pay=1.
    if ( '1' === (string) $atts['show_pay'] ) {
        wp_enqueue_style( 'agc-inv' );
        wp_enqueue_script( 'agc-inv' );
    }

    $form_id = absint( $atts['form_id'] ) ?: 2;
    $form_shortcode = '[gravityform id="' . $form_id . '" title="true" description="false"]';
    $form_html = do_shortcode( $form_shortcode );

    ob_start();
    ?>
    <div id="agc-buy">
        <!-- HERO -->
        <section class="buy-hero">
            <div class="buy-hero-inner">
                <div class="buy-hero-badge">Transparent Rates</div>
                <h1>Our Rates for <span>Buying Coins</span></h1>
                <p class="buy-sub">Concierge Service. Transparent Pricing. Guaranteed Rates.</p>
            </div>
        </section>

        <!-- WHY SELL -->
        <div class="buy-content">
            <h2>Why Sell to Atlanta Gold &amp; Coin?</h2>
            <p>When you&rsquo;re thinking about selling your coins, bullion, or coin collection, you&rsquo;ll want to shop around to get as much as possible for them. You won&rsquo;t find better gold coin prices or buying rates in the Atlanta area than at Atlanta Gold &amp; Coin.</p>
            <p>We offer among the most competitive rates in the industry for your gold, silver, platinum, palladium, coins, coin collections, bullion, bars, rounds, ingots, and more! But don&rsquo;t take our word for it&mdash;call around and check out the rates of our competitors for yourself&mdash;if they&rsquo;ll even reveal their rates; most other coin and bullion dealers like to keep their rates secret. Sometimes they will not even give quotes over the phone and try to pressure you to visit their place of business before they give any idea what they are paying.</p>
            <div class="buy-highlight">
                <p>At Atlanta Gold and Coin, we believe in transparency and are proud to provide our buying rates over the phone and also post our buying rates online. We know your time is as valuable as your coins, and we want to do whatever we can to help you make an informed decision when it comes time to sell.</p>
            </div>
            <p>You have the option to <a href="https://atlantagoldandcoin.com/sell-coins-online/" class="buy-link-green">mail in your coins</a>, or contact us to schedule an appointment to have us review and approve the coins you wish to sell.</p>
        </div>

        <!-- PROCESS -->
        <div class="buy-process">
            <div class="buy-process-inner">
                <h2>Our Buying Process</h2>
                <p>During your appointment, we will evaluate your items and make a no-obligation offer. At Atlanta Gold &amp; Coin, you&rsquo;ll never be pressured into selling when you aren&rsquo;t ready. If you accept our offer, we&rsquo;ll pay you on the spot via a company check or cash, if available. Other payment options may be available for sizable transactions.</p>
                <p>If you live outside the Atlanta area and send us your items for a mail-in appraisal, we&rsquo;ll notify you upon receipt of the items and will complete our evaluation and quote within one business day. If you accept the offer, we&rsquo;ll mail you a check. If you choose not to sell, we&rsquo;ll send the items back to you, return shipping on us (provided you contacted us before mailing your items to receive approval).</p>
            </div>
        </div>

        <!-- RATES INTRO -->
        <div class="buy-rates-intro">
            <h2>Our Buying Rates</h2>
            <p>Please note that the following rates are for common date average circulated condition coins, except for modern-issued investment coins, which are expected to be in uncirculated condition. We always pay premium rates for high-end condition and <a href="https://atlantagoldandcoin.com/rare-coin-guide/" class="buy-link-green">rare or key date coins</a> taking into consideration the year, where the coin was minted, the condition, the total number of coins produced and if the coin is certified by a third party grading service, such as NGC and PCGS.</p>
        </div>

        <?php if ( '1' === (string) $atts['show_pay'] ): ?>
            <div class="buy-rates-widget"><?php echo do_shortcode( '[agc_what_we_pay]' ); ?></div>
        <?php endif; ?>

        <!-- CTA BANNER -->
        <div class="buy-cta">
            <div class="buy-cta-inner">
                <p>Ready to sell your coins or bullion? Fill out our contact form or call to schedule your appointment!</p>
                <button type="button" class="buy-cta-btn" data-agc-buy-open="1">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    Schedule Appointment
                </button>
                <a href="tel:+14042369744" class="buy-cta-phone">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    (404) 236-9744
                </a>
            </div>
        </div>
    </div>

    <!-- SIDE DRAWER (appointment form) -->
    <button type="button" class="buy-drawer-fab" data-agc-buy-open="1" aria-label="Schedule appointment">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span class="buy-drawer-fab-label">Schedule</span>
    </button>
    <div class="buy-drawer-overlay" data-agc-buy-overlay hidden></div>
    <aside class="buy-drawer" aria-hidden="true" aria-labelledby="buy-drawer-title" data-agc-buy-drawer>
        <div class="buy-drawer-header">
            <div>
                <h2 id="buy-drawer-title">Schedule an Appointment</h2>
                <p>Meet with a specialist to discuss selling your coins, bullion, or collection.</p>
            </div>
            <button type="button" class="buy-drawer-close" data-agc-buy-close="1" aria-label="Close appointment form">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <div class="buy-drawer-body">
            <?php echo $form_html; // Gravity Forms output is already escaped/sanitized by the GF plugin. ?>
        </div>
    </aside>
    <?php
    return ob_get_clean();
}

function agc_inv_render_spot_strip( $spot ) {
    if ( ! is_array( $spot ) ) {
        return '<div class="agc-inv-spot-strip" data-agc-spot="empty"></div>';
    }
    $metals = [
        'gold'      => 'Gold',
        'silver'    => 'Silver',
        'platinum'  => 'Platinum',
        'palladium' => 'Palladium',
    ];
    $change = isset( $spot['change'] ) && is_array( $spot['change'] ) ? $spot['change'] : [];
    $html = '<div class="agc-inv-spot-strip" data-agc-spot="ready">';
    foreach ( $metals as $key => $label ) {
        $price = isset( $spot[ $key ] ) ? $spot[ $key ] : null;
        $html .= '<div class="agc-inv-spot agc-inv-spot--' . esc_attr( $key ) . '">';
        $html .= '<span class="agc-inv-spot-label">' . esc_html( $label ) . '</span>';
        $html .= '<span class="agc-inv-spot-price" data-agc-spot-metal="' . esc_attr( $key ) . '">';
        $html .= $price !== null
            ? '$' . esc_html( number_format( floatval( $price ), 2 ) )
            : '&mdash;';
        $html .= '</span>';
        // Change row: arrow + absolute delta + % change. Green when up,
        // red when down, grey when flat/missing.
        if ( isset( $change[ $key ] ) && is_array( $change[ $key ] ) ) {
            $delta   = isset( $change[ $key ]['delta'] ) ? floatval( $change[ $key ]['delta'] ) : null;
            $percent = isset( $change[ $key ]['percent'] ) ? floatval( $change[ $key ]['percent'] ) : null;
            if ( $delta !== null && $percent !== null ) {
                $dirClass = $delta > 0 ? 'up' : ( $delta < 0 ? 'down' : 'flat' );
                $arrow    = $delta > 0 ? '▲' : ( $delta < 0 ? '▼' : '—' );
                $sign     = $delta > 0 ? '+' : '';
                $html .= '<span class="agc-inv-spot-change agc-inv-spot-change--' . esc_attr( $dirClass ) . '">';
                $html .= '<span class="agc-inv-spot-change-arrow">' . $arrow . '</span>';
                $html .= esc_html( $sign . number_format( $delta, 2 ) . ' (' . $sign . number_format( $percent, 2 ) . '%)' );
                $html .= '</span>';
            }
        }
        $html .= '</div>';
    }
    $html .= '</div>';
    return $html;
}

/**
 * Themed error card — same typography + palette as the main widget so a
 * temporary outage doesn't clash with the shop's overall look.
 */
function agc_inv_error_card( $message ) {
    wp_enqueue_style( 'agc-inv' );
    return '<div class="agc-inv-wrap"><div class="agc-inv-error-card">'
        . '<strong>Just a moment &mdash;</strong> '
        . esc_html( $message ) . ' Call '
        . '<a href="tel:4042369744">404-236-9744</a> if you need pricing now.'
        . '</div></div>';
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function agc_inv_filter_by_metal( $items, $metal ) {
    $metal = strtolower( trim( $metal ) );
    if ( ! $metal ) {
        return $items;
    }
    return array_values( array_filter( $items, function ( $r ) use ( $metal ) {
        return isset( $r['metal'] ) && strtolower( $r['metal'] ) === $metal;
    } ) );
}

/**
 * Section order + labels for display-category buckets — MUST match
 * apps/web/src/lib/product-category.ts SECTIONS. The API tags each row
 * with `display_category` (slug) + `display_category_label`; this list
 * tells us which order to render them in and which sections to expose
 * even when empty (currently we drop empty ones to keep the UI tight).
 */
function agc_inv_display_sections() {
    return [
        [ 'id' => 'gold_coins',          'label' => 'Gold Coins',                        'metal' => 'gold' ],
        [ 'id' => 'us_mint_proof_gold',  'label' => 'US Mint Proof Gold Coins',          'metal' => 'gold' ],
        [ 'id' => 'gold_bars',           'label' => 'Gold Bars',                         'metal' => 'gold' ],
        [ 'id' => 'pre_1933_gold',       'label' => 'Pre-1933 U.S. Gold Coins',          'metal' => 'gold' ],
        [ 'id' => 'silver_coins',        'label' => 'Silver Coins',                      'metal' => 'silver' ],
        [ 'id' => 'morgan_peace_dollars','label' => 'Morgan and Peace Silver Dollars',   'metal' => 'silver' ],
        [ 'id' => 'silver_generic',      'label' => 'Silver Rounds / Bars (Generic)',    'metal' => 'silver' ],
        [ 'id' => 'silver_junk',         'label' => 'Junk Silver (90%)',                 'metal' => 'silver' ],
        [ 'id' => 'silver_mint_sets',    'label' => 'Silver U.S. Mint Sets',             'metal' => 'silver' ],
        [ 'id' => 'platinum_coins',      'label' => 'Platinum Coins',                    'metal' => 'platinum' ],
        [ 'id' => 'platinum_bars',       'label' => 'Platinum Bars',                     'metal' => 'platinum' ],
        [ 'id' => 'palladium_coins',     'label' => 'Palladium Coins',                   'metal' => 'palladium' ],
        [ 'id' => 'palladium_bars',      'label' => 'Palladium Bars',                    'metal' => 'palladium' ],
        [ 'id' => 'other',               'label' => 'Other',                             'metal' => 'other' ],
    ];
}

/**
 * Group items by their display_category slug, preserving the order in
 * agc_inv_display_sections(). The API already tags each row. Rows
 * missing a slug (older API versions, or bugs) fall through to 'other'.
 */
function agc_inv_group_by_display_category( $items ) {
    $sections = agc_inv_display_sections();
    $buckets  = [];
    $labels   = [];
    foreach ( $sections as $s ) {
        $buckets[ $s['id'] ] = [];
        $labels[ $s['id'] ]  = $s['label'];
    }
    foreach ( $items as $it ) {
        $slug = isset( $it['display_category'] ) ? $it['display_category'] : 'other';
        if ( ! isset( $buckets[ $slug ] ) ) {
            $buckets['other'][] = $it;
        } else {
            $buckets[ $slug ][] = $it;
        }
    }
    // Keep the SECTIONS ordering but drop empties. Return as ordered
    // list of [slug, label, rows] tuples — the renderer iterates this.
    $out = [];
    foreach ( $sections as $s ) {
        if ( ! empty( $buckets[ $s['id'] ] ) ) {
            $out[] = [
                'id'    => $s['id'],
                'label' => $s['label'],
                'rows'  => $buckets[ $s['id'] ],
            ];
        }
    }
    return $out;
}

/**
 * Toolbar — search input + clickable chips that scroll to each visible
 * section. Rendered above the sections on both widgets. Chips are built
 * from the list of sections actually present in the filtered response,
 * so empty sections don't produce dead chips.
 */
function agc_inv_render_toolbar( $sections, $widget ) {
    $placeholder = $widget === 'live-inventory'
        ? 'Search in-stock items...'
        : 'Search what we pay...';
    $html  = '<div class="agc-inv-toolbar">';
    $html .= '<div class="agc-inv-search">';
    $html .= '<input type="search" class="agc-inv-search-input" placeholder="' . esc_attr( $placeholder ) . '" aria-label="Search" />';
    $html .= '</div>';
    if ( ! empty( $sections ) ) {
        $html .= '<div class="agc-inv-chips" role="navigation" aria-label="Jump to category">';
        foreach ( $sections as $s ) {
            $html .= '<button type="button" class="agc-inv-chip" data-agc-target="agc-section-' . esc_attr( $s['id'] ) . '">';
            $html .= esc_html( $s['label'] );
            $html .= '</button>';
        }
        $html .= '</div>';
    }
    $html .= '</div>';
    return $html;
}

function agc_inv_pretty_metal( $metal ) {
    $map = [
        'gold'      => 'Gold',
        'silver'    => 'Silver',
        'platinum'  => 'Platinum',
        'palladium' => 'Palladium',
        'other'     => 'Other',
    ];
    return isset( $map[ $metal ] ) ? $map[ $metal ] : ucfirst( $metal );
}

// ─── Elementor widgets ─────────────────────────────────────────────────────
//
// Defined inline so there's no extra require step that could silently fail
// on sandboxes. Both classes extend \Elementor\Widget_Base, so we only
// define them once Elementor is confirmed loaded.

add_action( 'elementor/elements/categories_registered', function ( $elements_manager ) {
    $elements_manager->add_category( 'agc-desk', [
        'title' => 'AGC Desk',
        'icon'  => 'fa fa-coins',
    ] );
} );

add_action( 'elementor/widgets/register', function ( $widgets_manager ) {
    if ( ! did_action( 'elementor/loaded' ) ) {
        return;
    }
    if ( ! class_exists( '\\Elementor\\Widget_Base' ) ) {
        return;
    }

    if ( ! class_exists( 'AGC_Live_Inventory_Widget' ) ) {
        class AGC_Live_Inventory_Widget extends \Elementor\Widget_Base {
            public function get_name()       { return 'agc_live_inventory'; }
            public function get_title()      { return 'AGC Live Inventory'; }
            public function get_icon()       { return 'eicon-product-stock'; }
            public function get_categories() { return [ 'agc-desk' ]; }
            public function get_keywords()   { return [ 'agc', 'inventory', 'stock', 'live', 'bullion', 'coin' ]; }

            protected function register_controls() {
                $this->start_controls_section( 'content_section', [
                    'label' => 'Content',
                    'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
                ] );
                $this->add_control( 'metal', [
                    'label'   => 'Metal filter',
                    'type'    => \Elementor\Controls_Manager::SELECT,
                    'default' => '',
                    'options' => [
                        ''          => 'All metals',
                        'gold'      => 'Gold only',
                        'silver'    => 'Silver only',
                        'platinum'  => 'Platinum only',
                        'palladium' => 'Palladium only',
                    ],
                ] );
                $this->end_controls_section();
            }

            protected function render() {
                $settings = $this->get_settings_for_display();
                echo agc_inv_render_live_inventory( [
                    'metal' => $settings['metal'] ?? '',
                ] );
            }
        }
    }

    if ( ! class_exists( 'AGC_What_We_Pay_Widget' ) ) {
        class AGC_What_We_Pay_Widget extends \Elementor\Widget_Base {
            public function get_name()       { return 'agc_what_we_pay'; }
            public function get_title()      { return 'AGC What We Pay'; }
            public function get_icon()       { return 'eicon-price-list'; }
            public function get_categories() { return [ 'agc-desk' ]; }
            public function get_keywords()   { return [ 'agc', 'buy', 'price', 'bullion', 'coin', 'quote' ]; }

            protected function register_controls() {
                $this->start_controls_section( 'content_section', [
                    'label' => 'Content',
                    'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
                ] );
                $this->add_control( 'metal', [
                    'label'   => 'Metal filter',
                    'type'    => \Elementor\Controls_Manager::SELECT,
                    'default' => '',
                    'options' => [
                        ''          => 'All metals',
                        'gold'      => 'Gold only',
                        'silver'    => 'Silver only',
                        'platinum'  => 'Platinum only',
                        'palladium' => 'Palladium only',
                    ],
                ] );
                $this->end_controls_section();
            }

            protected function render() {
                $settings = $this->get_settings_for_display();
                echo agc_inv_render_what_we_pay( [
                    'metal' => $settings['metal'] ?? '',
                ] );
            }
        }
    }

    $widgets_manager->register( new AGC_Live_Inventory_Widget() );
    $widgets_manager->register( new AGC_What_We_Pay_Widget() );
} );

<?php
/**
 * Plugin Name:       AGC Inventory
 * Plugin URI:        https://agcdesk.com
 * Description:       Pulls live inventory and "What We Pay" from AGC Desk and
 *                    renders them as Elementor widgets or shortcodes on
 *                    atlantagoldandcoin.com. Refreshes every 5 minutes
 *                    between 8 AM and 6 PM Eastern.
 * Version:           1.0.0
 * Author:            Atlanta Gold and Coin
 * License:           Proprietary
 * Text Domain:       agc-inventory
 * Requires at least: 6.0
 * Requires PHP:      7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// ─── Constants ──────────────────────────────────────────────────────────────

define( 'AGC_INV_VERSION', '1.0.0' );
// Default AGC Desk API base. Operator can override on the settings page.
define( 'AGC_INV_DEFAULT_BASE', 'https://agc-api-production.up.railway.app/api/v1' );
// Server-side transient cache TTL.
//
// Was 60s, which made toggling a product off in AGC Desk take up to
// 2 minutes to disappear from the WP page (60s WP transient + 60s
// browser poll). 15s gives admins same-minute visibility when they
// flip show_on_website, at the cost of 4× more upstream fetches per
// minute — still trivial load for the API (one request per minute
// per visitor is the upper bound because the browser is still the
// gate, not the WP server).
//
// If you need stale data to disappear immediately (e.g. during a price
// demo), hit /wp-admin/admin-ajax.php?action=agc_inv_flush_cache as a
// logged-in admin — that busts the transient and the next browser poll
// fetches fresh in under a second.
define( 'AGC_INV_CACHE_TTL', 15 );
// Business-hours window for the browser auto-refresh. Changes to inventory
// only happen while the shop is open (US/Eastern), so don't hammer the API
// at 3 AM — first page-load after 8 AM picks up any overnight changes.
define( 'AGC_INV_WINDOW_START_HOUR', 8 );
define( 'AGC_INV_WINDOW_END_HOUR', 18 );

// ─── Options / Settings ────────────────────────────────────────────────────

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
        <form method="post" action="options.php">
            <?php settings_fields( 'agc_inv_settings' ); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="agc_inv_base">AGC Desk API base</label></th>
                    <td>
                        <input type="url" name="agc_inv_base" id="agc_inv_base"
                            value="<?php echo esc_attr( agc_inv_get_base() ); ?>"
                            class="regular-text" placeholder="<?php echo esc_attr( AGC_INV_DEFAULT_BASE ); ?>" />
                        <p class="description">
                            Base URL of the AGC Desk API, including <code>/api/v1</code>.
                            Leave blank to use the default.
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <h2>Shortcodes</h2>
        <p>If you're not using Elementor, drop either of these on a page or post:</p>
        <pre><code>[agc_live_inventory]
[agc_what_we_pay]</code></pre>

        <h2>Elementor</h2>
        <p>Two widgets appear under the <strong>AGC Desk</strong> category in the
        Elementor editor:</p>
        <ul style="list-style:disc; margin-left:20px;">
            <li><strong>AGC Live Inventory</strong> — in-stock items with quantity + sell price.</li>
            <li><strong>AGC What We Pay</strong> — every catalog item with the current buy price.</li>
        </ul>

        <h2>Refresh behavior</h2>
        <p>Both widgets auto-refresh every minute between
        <?php echo esc_html( AGC_INV_WINDOW_START_HOUR ); ?> AM and
        <?php echo esc_html( AGC_INV_WINDOW_END_HOUR - 12 ); ?> PM Eastern.
        Outside those hours the poll pauses to keep server load low — the
        first page-load after 8 AM pulls fresh data again.</p>

        <p>Server-side transient TTL is <code><?php echo esc_html( AGC_INV_CACHE_TTL ); ?>s</code>.
        When you toggle a product&rsquo;s &ldquo;On website&rdquo; switch in AGC Desk,
        the change propagates to this WordPress site within
        <code><?php echo esc_html( AGC_INV_CACHE_TTL + 60 ); ?>s</code> at the
        worst case (WP cache + 1 browser poll).</p>

        <p>
            <button
                type="button"
                class="button"
                id="agc-inv-flush-cache-btn"
                onclick="agcInvFlushCache(this);"
            >Flush cache now</button>
            <span id="agc-inv-flush-cache-result" style="margin-left: 12px;"></span>
        </p>
        <script>
        function agcInvFlushCache(btn) {
            btn.disabled = true;
            var out = document.getElementById('agc-inv-flush-cache-result');
            out.textContent = 'Flushing…';
            fetch(ajaxurl + '?action=agc_inv_flush_cache', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (json) {
                    out.textContent = (json && json.success)
                        ? '✓ Flushed. The next page-load fetches fresh.'
                        : '✗ Failed';
                })
                .catch(function () { out.textContent = '✗ Failed'; })
                .then(function () { btn.disabled = false; });
        }
        </script>
    </div>
    <?php
}

// ─── Manual cache flush (admin-only) ───────────────────────────────────────

/**
 * Admin-only AJAX endpoint that nukes both the /public/in-stock and
 * /public/what-we-pay transients. Useful when you've just toggled a
 * product off in AGC Desk and want the change to show up on
 * atlantagoldandcoin.com immediately instead of waiting up to
 * AGC_INV_CACHE_TTL seconds.
 *
 * Hit it at:
 *   /wp-admin/admin-ajax.php?action=agc_inv_flush_cache
 *
 * nopriv variant intentionally omitted — this is an admin convenience,
 * not a public API. Returns 403 to un-authed visitors.
 */
add_action( 'wp_ajax_agc_inv_flush_cache', function () {
    if ( ! current_user_can( 'manage_options' ) ) {
        wp_send_json_error( [ 'message' => 'forbidden' ], 403 );
    }
    delete_transient( 'agc_inv_' . md5( 'public/in-stock' ) );
    delete_transient( 'agc_inv_' . md5( 'public/what-we-pay' ) );
    wp_send_json_success( [ 'flushed' => true, 'at' => current_time( 'c' ) ] );
} );

// ─── WP AJAX endpoints (for browser-side 1-min poll) ───────────────────────

/**
 * Browser polls these every minute via fetch(). Each one is a thin proxy
 * to agc_inv_fetch() so the WP transient still does the rate-limiting.
 * We deliberately expose these to un-authed visitors (nopriv) because
 * both AGC Desk endpoints behind them are public to begin with.
 */
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
    // Mirror of the server filter. See PHP shortcode renderer for the
    // full rationale — zero-stock rows never appear on the Live Inventory
    // page, period, regardless of what the API hands us.
    $items = array_values( array_filter( $items, function ( $r ) {
        return isset( $r['available'] ) && intval( $r['available'] ) > 0;
    } ) );
    $items   = agc_inv_filter_by_metal( $items, $metal );
    $grouped = agc_inv_group_by_metal( $items );
    wp_send_json_success( [
        'grouped'  => $grouped,
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
    $items   = agc_inv_filter_by_metal( $payload['items'], $metal );
    $grouped = agc_inv_group_by_metal( $items );
    wp_send_json_success( [
        'grouped' => $grouped,
        'mode'    => 'what-we-pay',
        'updated' => current_time( 'g:i A' ),
    ] );
}

// ─── HTTP client w/ transient cache ─────────────────────────────────────────

/**
 * Fetch JSON from AGC Desk. Uses a WP transient so repeat page-loads within
 * AGC_INV_CACHE_TTL don't hit the API. Returns null on failure; callers
 * render a "currently unavailable" notice.
 */
function agc_inv_fetch( $path ) {
    $cache_key = 'agc_inv_' . md5( $path );
    $cached    = get_transient( $cache_key );
    if ( false !== $cached ) {
        return $cached;
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
    set_transient( $cache_key, $data, AGC_INV_CACHE_TTL );
    return $data;
}

// ─── Assets ────────────────────────────────────────────────────────────────

add_action( 'wp_enqueue_scripts', function () {
    // Instrument Sans from Google Fonts. Registered as a standalone style
    // so our main stylesheet can depend on it and hoist the @font-face
    // declarations into <head> before our selectors paint.
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
        // Browser-side refresh cadence. Lives in JS so the operator could
        // tweak it later without reshipping the plugin.
        'refreshMs'   => 60 * 1000,
        'windowStart' => AGC_INV_WINDOW_START_HOUR,
        'windowEnd'   => AGC_INV_WINDOW_END_HOUR,
    ] );
} );

// ─── Shortcodes ────────────────────────────────────────────────────────────

add_shortcode( 'agc_live_inventory', function ( $atts ) {
    $atts = shortcode_atts( [
        'metal' => '', // gold, silver, platinum, palladium, or empty = all
    ], $atts, 'agc_live_inventory' );
    return agc_inv_render_live_inventory( $atts );
} );

add_shortcode( 'agc_what_we_pay', function ( $atts ) {
    $atts = shortcode_atts( [ 'metal' => '' ], $atts, 'agc_what_we_pay' );
    return agc_inv_render_what_we_pay( $atts );
} );

// ─── Renderers (shared by shortcodes + Elementor widgets) ──────────────────

function agc_inv_render_live_inventory( $atts ) {
    wp_enqueue_style( 'agc-inv' );
    wp_enqueue_script( 'agc-inv' );

    $items = agc_inv_fetch( 'public/in-stock' );
    if ( ! is_array( $items ) ) {
        return '<div class="agc-inv-error">Inventory is temporarily unavailable. Please refresh in a moment.</div>';
    }
    // Defensive double-filter: the API's /public/in-stock already excludes
    // zero-stock rows, but if a future bug ever lets one through (or the
    // feed is ever pointed at a staging server with seeded zero-qty rows),
    // we still refuse to show them on the live inventory page.
    $items = array_values( array_filter( $items, function ( $r ) {
        return isset( $r['available'] ) && intval( $r['available'] ) > 0;
    } ) );
    $items = agc_inv_filter_by_metal( $items, $atts['metal'] );
    $grouped = agc_inv_group_by_metal( $items );

    ob_start();
    ?>
    <div class="agc-inv-wrap" data-agc-widget="live-inventory" data-agc-metal="<?php echo esc_attr( $atts['metal'] ); ?>">
        <?php if ( empty( $items ) ): ?>
            <p class="agc-inv-empty">Nothing in stock right now. Check back later, or call us at 404-236-9744.</p>
        <?php endif; ?>
        <?php foreach ( $grouped as $metal => $rows ): ?>
            <section class="agc-inv-section agc-inv-section--<?php echo esc_attr( $metal ); ?>">
                <h3 class="agc-inv-metal-heading"><?php echo esc_html( agc_inv_pretty_metal( $metal ) ); ?></h3>
                <table class="agc-inv-table">
                    <thead>
                        <tr>
                            <th class="agc-inv-col-item">Item</th>
                            <th class="agc-inv-col-qty">Qty</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ( $rows as $row ): ?>
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
            Refreshes every minute between 8 AM &ndash; 6 PM Eastern. Call
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
        return '<div class="agc-inv-error">Pricing is temporarily unavailable. Please refresh in a moment.</div>';
    }
    $items = $payload['items'];
    $items = agc_inv_filter_by_metal( $items, $atts['metal'] );
    $grouped = agc_inv_group_by_metal( $items );

    ob_start();
    ?>
    <div class="agc-inv-wrap" data-agc-widget="what-we-pay" data-agc-metal="<?php echo esc_attr( $atts['metal'] ); ?>">
        <?php if ( empty( $items ) ): ?>
            <p class="agc-inv-empty">Pricing coming soon.</p>
        <?php endif; ?>
        <?php foreach ( $grouped as $metal => $rows ): ?>
            <section class="agc-inv-section agc-inv-section--<?php echo esc_attr( $metal ); ?>">
                <h3 class="agc-inv-metal-heading"><?php echo esc_html( agc_inv_pretty_metal( $metal ) ); ?></h3>
                <table class="agc-inv-table">
                    <thead>
                        <tr>
                            <th class="agc-inv-col-item">Item</th>
                            <th class="agc-inv-col-price">We pay</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ( $rows as $row ): ?>
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
            Refreshes every minute between 8 AM &ndash; 6 PM Eastern. Prices
            are indicative; call <a href="tel:4042369744">404-236-9744</a> to lock in.
        </p>
    </div>
    <?php
    return ob_get_clean();
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

function agc_inv_group_by_metal( $items ) {
    $order = [ 'gold', 'silver', 'platinum', 'palladium' ];
    $buckets = [];
    foreach ( $order as $m ) {
        $buckets[ $m ] = [];
    }
    $buckets['other'] = [];
    foreach ( $items as $it ) {
        $m = isset( $it['metal'] ) ? strtolower( $it['metal'] ) : 'other';
        if ( ! isset( $buckets[ $m ] ) ) {
            $buckets['other'][] = $it;
        } else {
            $buckets[ $m ][] = $it;
        }
    }
    // Remove empty buckets so we don't render empty headings.
    return array_filter( $buckets, function ( $v ) { return ! empty( $v ); } );
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

// ─── Elementor widget registration ─────────────────────────────────────────

add_action( 'elementor/widgets/register', function ( $widgets_manager ) {
    if ( ! did_action( 'elementor/loaded' ) ) {
        return;
    }
    require_once __DIR__ . '/includes/class-agc-live-inventory-widget.php';
    require_once __DIR__ . '/includes/class-agc-what-we-pay-widget.php';
    $widgets_manager->register( new \AGC_Live_Inventory_Widget() );
    $widgets_manager->register( new \AGC_What_We_Pay_Widget() );
} );

add_action( 'elementor/elements/categories_registered', function ( $elements_manager ) {
    $elements_manager->add_category( 'agc-desk', [
        'title' => 'AGC Desk',
        'icon'  => 'fa fa-coins',
    ] );
} );

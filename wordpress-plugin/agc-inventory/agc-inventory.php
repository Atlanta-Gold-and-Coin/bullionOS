<?php
/**
 * Plugin Name:       AGC Inventory
 * Plugin URI:        https://agcdesk.com
 * Description:       Live inventory and "What We Pay" widgets for Atlanta
 *                    Gold & Coin, fed by the AGC Desk API. Elementor widgets
 *                    + shortcodes, auto-refreshing during shop hours.
 * Version:           2.0.2
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

define( 'AGC_INV_VERSION', '2.0.2' );
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
    $items   = agc_inv_filter_by_metal( $items, $metal );
    $grouped = agc_inv_group_by_metal( $items );
    wp_send_json_success( [
        'grouped' => $grouped,
        'mode'    => 'live-inventory',
        'updated' => current_time( 'g:i A' ),
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
    $items   = agc_inv_filter_by_metal( $items, $atts['metal'] );
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
        return agc_inv_error_card( 'Live pricing is temporarily unavailable. This usually resolves within a minute.' );
    }
    $items   = $payload['items'];
    $items   = agc_inv_filter_by_metal( $items, $atts['metal'] );
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
            are indicative; call <a href="tel:4042369744">404-236-9744</a> to schedule your appointment.
        </p>
    </div>
    <?php
    return ob_get_clean();
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

function agc_inv_group_by_metal( $items ) {
    $order   = [ 'gold', 'silver', 'platinum', 'palladium' ];
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

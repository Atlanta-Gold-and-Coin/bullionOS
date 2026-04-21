/**
 * AGC Buy Rates — side-drawer controller for the appointment form.
 *
 * Elements:
 *   [data-agc-buy-open]     — any button that, when clicked, opens the drawer
 *                              (CTA banner button + floating FAB both qualify)
 *   [data-agc-buy-close]    — the X inside the drawer
 *   [data-agc-buy-overlay]  — the translucent backdrop (click-to-close)
 *   [data-agc-buy-drawer]   — the drawer aside itself
 *
 * Behavior:
 *   - Opening adds `buy-drawer--open` + flips aria-hidden; shows overlay
 *     + locks body scroll; focuses the close button for keyboard users.
 *   - ESC closes. Clicking overlay closes.
 *   - Focus is NOT trapped inside the drawer (would fight Gravity Forms'
 *     own field-flow), but focus is restored to the opener on close.
 *
 * Safe to include on any page — no-ops when the drawer DOM isn't present.
 */
(function () {
    if (typeof document === 'undefined') return;

    function init() {
        var drawer = document.querySelector('[data-agc-buy-drawer]');
        var overlay = document.querySelector('[data-agc-buy-overlay]');
        if (!drawer || !overlay) return;

        var lastOpener = null;

        function open(opener) {
            if (opener) lastOpener = opener;
            drawer.setAttribute('aria-hidden', 'false');
            drawer.classList.add('buy-drawer--open');
            overlay.hidden = false;
            // Force reflow so the transition runs from opacity:0 (hidden)
            // to opacity:1 (open class).
            // eslint-disable-next-line no-unused-expressions
            overlay.offsetHeight;
            overlay.classList.add('buy-drawer-overlay--open');
            document.body.classList.add('buy-drawer-locked');
            var closeBtn = drawer.querySelector('[data-agc-buy-close]');
            if (closeBtn && typeof closeBtn.focus === 'function') {
                // Defer focus until after the slide-in animation starts,
                // otherwise screen readers announce the close button
                // before the drawer's header is announced.
                setTimeout(function () {
                    closeBtn.focus();
                }, 60);
            }
        }

        function close() {
            drawer.setAttribute('aria-hidden', 'true');
            drawer.classList.remove('buy-drawer--open');
            overlay.classList.remove('buy-drawer-overlay--open');
            document.body.classList.remove('buy-drawer-locked');
            // Hide overlay from the a11y tree after the fade finishes so
            // Tab focus can't land on it.
            setTimeout(function () {
                if (!overlay.classList.contains('buy-drawer-overlay--open')) {
                    overlay.hidden = true;
                }
            }, 260);
            if (lastOpener && typeof lastOpener.focus === 'function') {
                lastOpener.focus();
            }
        }

        // Open triggers — delegated so we catch both the CTA button AND
        // the floating FAB without separate bindings.
        document.addEventListener('click', function (e) {
            var opener = e.target.closest ? e.target.closest('[data-agc-buy-open]') : null;
            if (opener) {
                e.preventDefault();
                open(opener);
                return;
            }
            var closer = e.target.closest ? e.target.closest('[data-agc-buy-close]') : null;
            if (closer) {
                e.preventDefault();
                close();
            }
        });

        // Click on overlay closes. Not on the drawer itself.
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) close();
        });

        // ESC closes.
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && drawer.classList.contains('buy-drawer--open')) {
                close();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

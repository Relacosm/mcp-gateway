<?php
/**
 * Plugin Name: Urumi storefront skin
 * Description: Mono, square, warm-paper look for the storefront, with a light/dark switch.
 *              Mounted by the Helm chart as a must-use plugin; it only adds CSS and a tiny script.
 */

if (!defined('ABSPATH')) exit;

// Saved choice applied before first paint, so there is no flash of the wrong theme.
add_action('wp_head', function () {
    if (is_admin()) return;
    echo "<script>try{var t=localStorage.getItem('urumi-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}</script>\n";
    echo '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
    echo '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..700&display=swap" rel="stylesheet">' . "\n";
}, 1);

add_action('wp_head', function () {
    if (is_admin()) return;
    ?>
<style id="urumi-skin">
html:root {
  --u-bg: #f4f2ee; --u-text: #2b2926; --u-muted: #5e5952; --u-line: #3d3a36; --u-soft: #dedad3;
  --u-hover: #ebe8e2; --u-invert: #f4f2ee; --u-shadow: #d3cec5; --u-sale: #b9503f;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  html:root:not([data-theme='light']) {
    --u-bg: #1b1a19; --u-text: #d6d2cb; --u-muted: #a8a299; --u-line: #57534d; --u-soft: #2c2a28;
    --u-hover: #232220; --u-invert: #1b1a19; --u-shadow: #0f0f0e; --u-sale: #d9796a;
    color-scheme: dark;
  }
}
html:root[data-theme='dark'] {
  --u-bg: #1b1a19; --u-text: #d6d2cb; --u-muted: #a8a299; --u-line: #57534d; --u-soft: #2c2a28;
  --u-hover: #232220; --u-invert: #1b1a19; --u-shadow: #0f0f0e; --u-sale: #d9796a;
  color-scheme: dark;
}
/* Point the theme's own palette at ours, so every block follows. */
html:root, html:root body {
  --wp--preset--color--base: var(--u-bg);
  --wp--preset--color--contrast: var(--u-text);
  --wp--preset--color--accent-1: var(--u-hover);
  --wp--preset--color--accent-2: var(--u-soft);
  --wp--preset--color--accent-3: var(--u-text);
  --wp--preset--color--accent-4: var(--u-muted);
  --wp--preset--color--accent-5: var(--u-hover);
  --wp--preset--color--accent-6: var(--u-soft);
  --wp--preset--font-family--manrope: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
  --wp--preset--font-family--fira-code: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
}
html body {
  background: var(--u-bg) !important;
  color: var(--u-text);
  font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace !important;
  font-size: 15px;
  font-weight: 450;
  transition: background .2s, color .2s;
}
body * { font-family: inherit !important; border-radius: 0 !important; }
::selection { background: var(--u-text); color: var(--u-invert); }

/* Headings and labels: uppercase, tracked out. */
body h1, body h2, body h3, body .wp-block-site-title, body .wp-block-post-title,
body .wc-block-components-title, body .wc-block-components-product-name {
  text-transform: uppercase; letter-spacing: .14em; font-weight: 600 !important;
}
body h1, body .wp-block-query-title { font-size: clamp(18px, 2.4vw, 28px) !important; }
body h2 { font-size: clamp(14px, 1.6vw, 20px) !important; }
body h3, body .wc-block-components-product-name { font-size: 14px !important; }
body .wp-block-site-title a { text-decoration: none; display: inline-flex; align-items: center; gap: 12px; font-size: 14px; }
body .wp-block-site-title a::before { content: ''; width: 8px; height: 8px; border-radius: 50% !important; background: currentColor; }
body a { color: inherit; text-underline-offset: 3px; }

/* Header and footer sit between hairlines. */
body .wp-site-blocks > header, body header.wp-block-template-part { border-bottom: 1px solid var(--u-line); }
body .wp-site-blocks > footer, body footer.wp-block-template-part { border-top: 1px solid var(--u-line); margin-top: 64px; }
body .wp-block-navigation a { text-transform: uppercase; letter-spacing: .14em; font-size: 12px; text-decoration: none; }
body .wp-block-navigation a:hover { text-decoration: underline; }

/* Buttons: solid ink, invert on hover. */
body .wp-element-button, body .wp-block-button__link, body .wc-block-components-button,
body button:not(.wp-block-navigation__responsive-container-open):not(.wp-block-navigation__responsive-container-close):not(.urumi-theme):not(.wc-block-mini-cart__button),
body input[type='submit'], body .button, body a.added_to_cart {
  background: var(--u-text) !important; color: var(--u-invert) !important;
  border: 1px solid var(--u-line) !important; box-shadow: none !important;
  text-transform: uppercase; letter-spacing: .16em; font-size: 12px !important; font-weight: 600 !important;
  padding: 12px 20px !important; transition: background .12s, color .12s;
}
body .wp-element-button:hover, body .wp-block-button__link:hover, body .wc-block-components-button:hover,
body button:not(.urumi-theme):not(.wc-block-mini-cart__button):hover, body input[type='submit']:hover, body .button:hover {
  background: var(--u-bg) !important; color: var(--u-text) !important;
}
body .wc-block-components-button__text { color: inherit !important; }
/* Header icons (mini cart, account) stay quiet: no filled block. */
body button.wc-block-mini-cart__button, body .wc-block-mini-cart__button {
  background: transparent !important; color: var(--u-text) !important; border: 1px solid var(--u-line) !important;
  padding: 8px 10px !important;
}
body button.wc-block-mini-cart__button:hover { background: var(--u-text) !important; color: var(--u-invert) !important; }

/* Fields: square, hairline. */
body input:not([type='checkbox']):not([type='radio']):not([type='submit']), body select, body textarea,
body .wc-block-components-text-input input, body .wc-blocks-components-select__select {
  background: var(--u-bg) !important; color: var(--u-text) !important;
  border: 1px solid var(--u-line) !important; box-shadow: none !important;
}
body .wc-block-components-text-input label, body .wc-blocks-components-select__label { color: var(--u-muted) !important; }
body input[type='checkbox'], body input[type='radio'] { accent-color: var(--u-text); }

/* Products: each one a bordered tile. */
body .wc-block-product, body ul.products li.product, body .wc-block-grid__product {
  border: 1px solid var(--u-soft); padding: 16px !important; background: var(--u-bg);
  transition: border-color .15s, box-shadow .15s;
}
body .wc-block-product:hover, body ul.products li.product:hover, body .wc-block-grid__product:hover {
  border-color: var(--u-line); box-shadow: 6px 6px 0 var(--u-shadow);
}
body .wc-block-components-product-image img, body .wp-block-woocommerce-product-image img,
body .woocommerce-product-gallery img { border: 1px solid var(--u-soft); }
body .wc-block-components-product-price, body .price, body .wp-block-woocommerce-product-price { font-variant-numeric: tabular-nums; }
body del, body .wc-block-components-product-price__regular { color: var(--u-muted) !important; }
body ins, body .wc-block-components-product-price__value.is-discounted { color: var(--u-sale) !important; text-decoration: none; }
body .wc-block-components-product-sale-badge, body .onsale {
  background: var(--u-text) !important; color: var(--u-invert) !important; border: none !important;
  text-transform: uppercase; letter-spacing: .14em; font-size: 11.5px !important;
}

/* Cart, checkout and notices: hairline panels. */
body .wc-block-components-sidebar, body .wc-block-cart__sidebar, body .wc-block-checkout__sidebar,
body .wc-block-components-totals-wrapper, body .wc-block-components-order-summary,
body .woocommerce-order, body .wp-block-woocommerce-order-confirmation-summary {
  border-color: var(--u-soft) !important;
}
body .wc-block-components-notice-banner, body .woocommerce-message, body .woocommerce-info, body .woocommerce-error {
  background: var(--u-bg) !important; color: var(--u-text) !important;
  border: 1px solid var(--u-line) !important; box-shadow: none !important;
}
body .wc-block-components-notice-banner svg { fill: var(--u-text) !important; background: transparent !important; }
body .wc-block-components-radio-control__option, body .wc-block-components-radio-control-accordion-option {
  border-color: var(--u-soft) !important; box-shadow: none !important;
}
body .wc-block-components-radio-control__option--checked-option-highlighted,
body .wc-block-components-radio-control-accordion-option--checked-option-highlighted {
  box-shadow: inset 0 0 0 1px var(--u-line) !important;
}
body table, body th, body td { border-color: var(--u-soft) !important; }
body hr, body .wp-block-separator { border-color: var(--u-soft) !important; opacity: 1; }
body .wc-block-mini-cart__badge { background: var(--u-text) !important; color: var(--u-invert) !important; }
body .wc-block-mini-cart__button svg, body .wc-block-customer-account svg { fill: currentColor; }
body .wp-block-woocommerce-mini-cart-contents, body .wc-block-mini-cart__drawer .components-modal__content {
  background: var(--u-bg) !important; color: var(--u-text) !important;
}
/* Quiet background grid behind the page. */
body .wp-site-blocks {
  background-image: radial-gradient(var(--u-soft) 1px, transparent 1px);
  background-size: 22px 22px;
}
body .wp-site-blocks > main, body .wp-site-blocks > header, body .wp-site-blocks > footer { background: var(--u-bg); }

/* Dark mode: dim bright placeholder images instead of letting them glare. */
@media (prefers-color-scheme: dark) {
  html:not([data-theme='light']) body img[src*='placeholder'] { filter: invert(.86) hue-rotate(180deg); }
}
html[data-theme='dark'] body img[src*='placeholder'] { filter: invert(.86) hue-rotate(180deg); }
html[data-theme='dark'] body img:not([src*='placeholder']) { opacity: .92; }

/* Light / dark switch, bottom right. */
.urumi-theme {
  position: fixed; right: 18px; bottom: 18px; z-index: 99999;
  display: inline-flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; padding: 0; cursor: pointer;
  border: 1px solid var(--u-line); background: var(--u-bg); color: var(--u-text);
  box-shadow: 4px 4px 0 var(--u-shadow); transition: background .12s, color .12s;
}
.urumi-theme:hover { background: var(--u-text); color: var(--u-invert); }
.urumi-theme svg { width: 17px; height: 17px; transition: transform .3s; }
.urumi-theme:hover svg { transform: rotate(20deg); }
.urumi-theme .sun { display: none; }
html[data-theme='dark'] .urumi-theme .sun { display: block; }
html[data-theme='dark'] .urumi-theme .moon { display: none; }
@media (prefers-color-scheme: dark) {
  html:not([data-theme='light']) .urumi-theme .sun { display: block; }
  html:not([data-theme='light']) .urumi-theme .moon { display: none; }
}

/* Back link at the top of every page except the home page. */
.urumi-back {
  display: inline-block; margin-top: 24px; padding: 6px 12px;
  font-size: 12px; letter-spacing: .14em; text-transform: uppercase; text-decoration: none;
  color: var(--u-text) !important; border: 1px solid var(--u-line); background: var(--u-bg);
}
.urumi-back:hover { background: var(--u-text); color: var(--u-invert) !important; }
.urumi-back-row { max-width: var(--wp--style--global--wide-size, 1340px); margin: 0 auto; padding: 0 var(--wp--preset--spacing--50, 24px); }
</style>
    <?php
}, 100);

add_action('wp_footer', function () {
    if (is_admin()) return;
    ?>
<button class="urumi-theme" type="button" aria-label="Switch light or dark" title="Switch light / dark">
  <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
  <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
</button>
<script>
(function () {
  var el = document.documentElement, btn = document.querySelector('.urumi-theme');
  function current() {
    var t = el.dataset.theme;
    return t === 'light' || t === 'dark' ? t : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function paint() {
    var t = current();
    btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  btn.addEventListener('click', function () {
    var t = current() === 'dark' ? 'light' : 'dark';
    el.dataset.theme = t;
    try { localStorage.setItem('urumi-theme', t); } catch (e) {}
    paint();
  });
  paint();
})();
</script>
    <?php
    if (is_front_page()) return;
    ?>
<script>
(function () {
  // Back to the previous page on this store, or to the shop when there is none.
  var main = document.querySelector('.wp-site-blocks > main, main');
  if (!main) return;
  var row = document.createElement('div');
  row.className = 'urumi-back-row';
  var a = document.createElement('a');
  a.className = 'urumi-back';
  a.href = <?php echo wp_json_encode(home_url('/')); ?>;
  a.textContent = '← Back';
  a.addEventListener('click', function (e) {
    var sameSite = document.referrer && new URL(document.referrer).origin === location.origin;
    if (sameSite && history.length > 1) { e.preventDefault(); history.back(); }
  });
  row.appendChild(a);
  main.insertBefore(row, main.firstChild);
})();
</script>
    <?php
});

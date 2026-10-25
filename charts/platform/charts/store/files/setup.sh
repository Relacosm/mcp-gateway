#!/bin/sh
# One-time store setup with WP-CLI. Every step checks before it acts, so the
# Job is safe to re-run on each "helm upgrade".
set -eu
cd /var/www/html

echo "==> waiting for WordPress files"
until [ -f wp-config.php ]; do sleep 3; done

echo "==> waiting for the database"
until php -r 'exit(@mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")) ? 0 : 1);'; do
  sleep 3
done

echo "==> WordPress core"
if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$SITE_URL" --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_password="$ADMIN_PASSWORD" \
    --admin_email="$ADMIN_EMAIL" --skip-email
fi
wp option update siteurl "$SITE_URL"
wp option update home "$SITE_URL"
wp option update blogname "$SITE_TITLE"
wp option update timezone_string "$TIMEZONE"

echo "==> remove WordPress demo content (once)"
# A marker option makes this one-time, so a later page that reuses a slug is kept.
if ! wp option get urumi_demo_content_removed >/dev/null 2>&1; then
  ids="$(wp post list --post_type=post --name=hello-world --post_status=any --format=ids) $(wp post list --post_type=page --name=sample-page --post_status=any --format=ids)"
  if [ -n "$(echo $ids)" ]; then wp post delete $ids --force; fi
  wp option add urumi_demo_content_removed yes
fi

echo "==> store footer (replaces the theme's demo links)"
# A saved "footer" template part overrides the theme's own footer.
if [ -z "$(wp post list --post_type=wp_template_part --name=footer --post_status=any --format=ids)" ]; then
  footer_id=$(cat <<EOF | wp post create - --post_type=wp_template_part --post_name=footer --post_title=Footer --post_status=publish --porcelain
<!-- wp:group {"style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group" style="padding-top:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50)"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size">© 2026 $SITE_TITLE · Cash on delivery</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->
EOF
)
  wp post term set "$footer_id" wp_theme "$(wp option get stylesheet)"
  wp post term set "$footer_id" wp_template_part_area footer
fi

echo "==> WooCommerce plugin"
if ! wp plugin is-installed woocommerce; then
  if [ -n "${WC_VERSION:-}" ]; then
    wp plugin install woocommerce --version="$WC_VERSION"
  else
    wp plugin install woocommerce
  fi
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

echo "==> store basics"
wp option update woocommerce_default_country "$COUNTRY"
wp option update woocommerce_currency "$CURRENCY"
wp option update woocommerce_store_address "$ADDRESS"
wp option update woocommerce_store_city "$CITY"
wp option update woocommerce_store_postcode "$POSTCODE"
# New stores start in "coming soon" mode, which hides the shop from customers.
wp option update woocommerce_coming_soon no
wp option update woocommerce_store_pages_only no
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp wc tool run install_pages --user="$ADMIN_USER"
# The home page is the product grid, not WordPress's default list of blog posts.
wp option update show_on_front page
wp option update page_on_front "$(wp option get woocommerce_shop_page_id)"

echo "==> cash on delivery"
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

echo "==> free shipping everywhere (zone 0 = rest of the world)"
if [ "$(wp wc shipping_zone_method list 0 --user="$ADMIN_USER" --format=count)" = "0" ]; then
  wp wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true --user="$ADMIN_USER"
fi

echo "==> starter products (once)"
# One-time, so products the owner deletes later do not come back on upgrade.
if ! wp option get urumi_catalog_seeded >/dev/null 2>&1; then
  wp eval-file /setup/catalog.php /setup/catalog.json
  wp option add urumi_catalog_seeded yes
fi

echo "==> REST API key for the Woo MCP server"
wp eval-file /setup/apikey.php

echo "==> done"

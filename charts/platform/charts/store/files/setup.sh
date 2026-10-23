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

echo "==> cash on delivery"
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

echo "==> free shipping everywhere (zone 0 = rest of the world)"
if [ "$(wp wc shipping_zone_method list 0 --user="$ADMIN_USER" --format=count)" = "0" ]; then
  wp wc shipping_zone_method create 0 --method_id=free_shipping --enabled=true --user="$ADMIN_USER"
fi

echo "==> sample product"
if [ "$(wp wc product list --user="$ADMIN_USER" --format=count)" = "0" ]; then
  wp wc product create --name="Urumi T-shirt" --regular_price=499 --status=publish \
    --description="Soft cotton tee." --user="$ADMIN_USER"
fi

echo "==> REST API key for the Woo MCP server"
wp eval-file /setup/apikey.php

echo "==> done"

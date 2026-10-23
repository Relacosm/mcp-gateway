# WordPress with the WooCommerce plugin already inside, so a new store does not
# download it at creation time. Only software is baked in: every store's
# settings (name, admin, currency, COD, API key) are still applied per store by
# the setup Job.
ARG WORDPRESS_IMAGE=wordpress:7.0-php8.3-apache
FROM ${WORDPRESS_IMAGE}

ARG WOOCOMMERCE_VERSION=11.2.1
# The image's entrypoint copies /usr/src/wordpress onto an empty content volume
# on first start, so a plugin placed here ships with every new store.
RUN set -eux; \
    curl -fsSL -o /tmp/woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    php -r '$z = new ZipArchive(); if ($z->open("/tmp/woocommerce.zip") !== true) exit(1); $z->extractTo("/usr/src/wordpress/wp-content/plugins/"); $z->close();'; \
    rm /tmp/woocommerce.zip; \
    chown -R www-data:www-data /usr/src/wordpress/wp-content/plugins/woocommerce; \
    test -f /usr/src/wordpress/wp-content/plugins/woocommerce/woocommerce.php

<?php
// Adds the store's starter products (store.catalogs.<catalog> in the chart).
// Run by setup.sh as: wp eval-file catalog.php <catalog.json>
// Products that already exist by name are left alone.

$catalog = json_decode(file_get_contents($args[0]), true);
if (!$catalog) {
  WP_CLI::error('catalog.json is empty or not valid JSON');
}
if (empty($catalog['products'])) {
  WP_CLI::log('no starter products for this store type');
  return;
}

$term = term_exists($catalog['category'], 'product_cat') ?: wp_insert_term($catalog['category'], 'product_cat');
if (is_wp_error($term)) {
  WP_CLI::error($term->get_error_message());
}
$category_id = (int) $term['term_id'];

foreach ($catalog['products'] as $item) {
  if (wc_get_products(['name' => $item['name'], 'limit' => 1, 'status' => 'any'])) {
    WP_CLI::log("exists: {$item['name']}");
    continue;
  }
  $product = new WC_Product_Simple();
  $product->set_name($item['name']);
  $product->set_regular_price((string) $item['price']);
  $product->set_description($item['description']);
  $product->set_short_description($item['description']);
  $product->set_category_ids([$category_id]);
  $product->set_status('publish');
  $product->save();
  WP_CLI::log("created: {$item['name']}");
}

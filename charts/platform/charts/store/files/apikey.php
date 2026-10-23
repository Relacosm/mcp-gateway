<?php
// Registers the consumer key/secret from the Kubernetes Secret as a
// WooCommerce REST API key. WooCommerce stores the key as an HMAC hash and the
// secret in plain text, the same as when an admin creates one in wp-admin.
global $wpdb;

$ck = getenv('WC_CONSUMER_KEY');
$cs = getenv('WC_CONSUMER_SECRET');
$user = get_user_by('login', getenv('ADMIN_USER'));
if (!$ck || !$cs || !$user) {
    WP_CLI::error('missing consumer key/secret or admin user');
}

$table = $wpdb->prefix . 'woocommerce_api_keys';
$hash = wc_api_hash($ck);
$id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash));

if ($id) {
    $wpdb->update($table, ['consumer_secret' => $cs, 'permissions' => 'read_write', 'user_id' => $user->ID], ['key_id' => $id]);
    WP_CLI::success("API key #$id already registered");
} else {
    $wpdb->insert($table, [
        'user_id' => $user->ID,
        'description' => 'woo-mcp (managed by Helm)',
        'permissions' => 'read_write',
        'consumer_key' => $hash,
        'consumer_secret' => $cs,
        'truncated_key' => substr($ck, -7),
    ]);
    WP_CLI::success('API key registered');
}

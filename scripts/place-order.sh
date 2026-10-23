#!/usr/bin/env bash
# Place a cash-on-delivery order through the WooCommerce Store API, the same
# cart + checkout API the storefront's checkout page uses.
#   scripts/place-order.sh [product-id] [store-url]
set -euo pipefail
PRODUCT="${1:-}"
STORE="${2:-http://store.localtest.me}"
JAR="$(mktemp)"; HDR="$(mktemp)"; trap 'rm -f "$JAR" "$HDR"' EXIT

api() { curl -s -c "$JAR" -b "$JAR" "$@"; }

api -D "$HDR" -o /dev/null "$STORE/?rest_route=/wc/store/v1/cart"
NONCE=$(grep -i '^nonce:' "$HDR" | tr -d '\r' | awk '{print $2}')
TOKEN=$(grep -i '^cart-token:' "$HDR" | tr -d '\r' | awk '{print $2}')
H=(-H "Nonce: $NONCE" -H "Cart-Token: $TOKEN" -H 'Content-Type: application/json')

if [ -z "$PRODUCT" ]; then
  PRODUCT=$(api "$STORE/?rest_route=/wc/store/v1/products&per_page=1" | sed -E 's/^\[\{"id":([0-9]+).*/\1/')
fi
api "${H[@]}" -o /dev/null -d "{\"id\":$PRODUCT,\"quantity\":1}" "$STORE/?rest_route=/wc/store/v1/cart/add-item"

ADDR='{"first_name":"Asha","last_name":"Rao","address_1":"12 Park St","city":"Bengaluru","state":"KA","postcode":"560001","country":"IN","email":"asha@example.com","phone":"9999999999"}'
api "${H[@]}" -d "{\"billing_address\":$ADDR,\"shipping_address\":$ADDR,\"payment_method\":\"cod\"}" \
  "$STORE/?rest_route=/wc/store/v1/checkout" | grep -oE '"order_id":[0-9]+|"status":"[a-z-]+"' | tr '\n' ' '
echo

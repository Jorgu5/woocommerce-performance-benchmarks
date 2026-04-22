# k6 Load Tests

Server-side performance benchmarks. Runs from your local machine against the provisioned WooCommerce server (see [`../docs/setup-hetzner.md`](../docs/setup-hetzner.md)).

## Install

[k6 installation guide](https://k6.io/docs/get-started/installation/).

```bash
brew install k6                 # macOS
# or: sudo apt install k6       # Ubuntu
```

## Run

```bash
./bench.sh <mode> <scenario> <profile>
```

Examples:

```bash
./bench.sh classic s1 baseline   # Add to cart, 1 VU, 2 min
./bench.sh storeapi s6 heavy     # Checkout, 500 VU, 9 min
./bench.sh classic s4 light      # Apply coupon, 50 VU, 7 min
```

## Arguments

### Modes

- `classic` — uses `wc-ajax` endpoints (shortcode checkout site)
- `storeapi` — uses `/wp-json/wc/store/v1/*` (block checkout site)

### Scenarios

| Scenario | Operation | k6 file |
|----------|-----------|---------|
| `s1` | Add to cart | `scenarios/s1-add-to-cart.js` |
| `s2` | View cart | `scenarios/s2-view-cart.js` |
| `s3` | Update quantity | `scenarios/s3-update-quantity.js` |
| `s4` | Apply coupon | `scenarios/s4-apply-coupon.js` |
| `s5` | Remove coupon | `scenarios/s5-remove-coupon.js` |
| `s6` | Checkout (place order) | `scenarios/s6-checkout.js` |
| `s7` | Full journey with think time | `scenarios/s7-full-journey.js` |
| `s8` | Realistic checkout (randomised) | `scenarios/s8-realistic-checkout.js` |
| `s9` | Fidgety shopper (~12 cart ops/session) | `scenarios/s9-fidgety-shopper.js` |
| `s10` | Subscription checkout | `scenarios/s10-subscription-checkout.js` |

### Load Profiles

| Profile | Stages | Duration | Total requests (approx) |
|---------|--------|----------|------------------------|
| `baseline` | 1 VU constant | 2 min | 1,400 (add-to-cart) |
| `light` | Ramp to 50 VU, sustain | 7 min | 60,000 |
| `medium` | Ramp to 200 VU, sustain | 8 min | 110,000 |
| `heavy` | Ramp to 500 VU, sustain | 9 min | 90,000 |
| `breaking` | Ramp to 500 with thresholds | 10 min | varies |

Profile definitions live in `run.js`.

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `MODE` | required | `classic` or `storeapi` |
| `SCENARIO` | required | `s1` through `s10` |
| `PROFILE` | required | `baseline`, `light`, `medium`, `heavy`, `breaking` |
| `CLASSIC_URL` | `https://classic.example.com` | Classic site URL |
| `STOREAPI_URL` | `https://storeapi.example.com` | Store API site URL |
| `PRODUCT_ID` | `15` | Product to add to cart |
| `COUPON_CODE` | `TEST10` | Coupon for s4/s5/s7 |
| `SKIP_NONCE` | unset | Store API only — skip nonce fetch when mu-plugin disables nonce check |

For multisite subdirectory mode, just include the subsite path in the URL:

```bash
CLASSIC_URL=https://classic-ms.example.com/store1 \
  ./bench.sh classic s6 medium
```

## Output

Results are written to `../results/<mode>-<scenario>-<profile>-<timestamp>.json`.

Each JSON file contains the full k6 summary metrics. The key ones:

- `metrics.target_duration` — wall-clock time for the target operation (excludes session setup)
- `metrics.http_req_duration` — HTTP-level timing
- `metrics.http_req_failed` — failure rate
- `metrics.target_success` / `metrics.target_fail` — operation success counts
- `metrics.iteration_duration` — full iteration including setup

## The k6 nonce helper mu-plugin

WooCommerce rotates nonces when cart state changes. To avoid measuring nonce refresh as part of the target operation, we fetch nonces up-front via a minimal mu-plugin:

```php
// wp-content/mu-plugins/k6-nonce-helper.php (classic)
add_action( 'init', function () {
    if ( ! isset( $_GET['k6_get_nonce'] ) ) return;
    $type = sanitize_text_field( $_GET['k6_get_nonce'] );
    $nonces = [];
    if ( $type === 'all' || $type === 'checkout' ) {
        $nonces['checkout_nonce'] = wp_create_nonce( 'woocommerce-process_checkout' );
    }
    if ( $type === 'all' || $type === 'coupon' ) {
        $nonces['apply_coupon_nonce']  = wp_create_nonce( 'apply-coupon' );
        $nonces['remove_coupon_nonce'] = wp_create_nonce( 'remove-coupon' );
    }
    header( 'Content-Type: application/json' );
    echo json_encode( $nonces );
    exit;
} );
```

Full mu-plugin source in [`../docs/setup-hetzner.md`](../docs/setup-hetzner.md).

## Running all scenarios

```bash
# Baseline for all scenarios (both modes)
for S in s1 s2 s4 s6; do
  for M in classic storeapi; do
    EXTRA=""
    [ "$M" = "storeapi" ] && EXTRA="-e SKIP_NONCE=1"
    ./bench.sh $M $S baseline $EXTRA
  done
done
```

## Fair comparison design

See [`../docs/methodology.md`](../docs/methodology.md) for why we tag only the target operation, why nonces are fetched once per VU, and why stock management is disabled during tests.

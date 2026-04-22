# Methodology

How we designed the tests, what we measured, and the decisions behind them.

---

## Core Principle: Fair Comparison

Both WooCommerce instances ran on the **same server**, with:

- Identical WordPress 6.9.4 + WooCommerce 10.6.2 + theme (GeneratePress)
- Identical plugin set (WC Subscriptions, WC Payments in Session 1)
- Identical hardware (OLS, LSPHP, MariaDB, Redis — separate DB indices)
- Identical product catalog (same IDs, imported from the same XML)
- Same k6 scripts, same Puppeteer test fixtures

**The only meaningful difference:**

- `classic.example.com`: checkout page is `[woocommerce_checkout]` shortcode → uses `wc-ajax` endpoints
- `storeapi.example.com`: checkout page is the `woocommerce/checkout` block → uses `/wp-json/wc/store/v1/*`

Each test was run at least 3 times; reported numbers are medians.

---

## WooCommerce Performance Features (all enabled)

WC 10.5+ ships several performance features that default to **off**. Testing with defaults gave unfair results — Store API was ~9% slower across the board because it makes more API calls that benefit from these caches.

Enabled on both instances:

| Feature | Default | Set to | Why |
|---------|---------|--------|-----|
| `woocommerce_custom_orders_table_enabled` (HPOS) | off | **on** | ~1.5× faster checkout |
| `woocommerce_hpos_datastore_caching_enabled` | off | **on** | Cache order objects |
| `woocommerce_feature_rest_api_caching_enabled` | off | **on** | Cache REST responses |
| `woocommerce_feature_product_instance_caching_enabled` | off | **on** | Cache product hydration |
| `woocommerce_feature_destroy-empty-sessions_enabled` | off | **on** | Clean up empty sessions |
| `woocommerce_feature_order_attribution_enabled` | on | **off** | Reduces tracking overhead |
| `woocommerce_feature_remote_logging_enabled` | on | **off** | Removes logging roundtrips |
| `WP_DEBUG` | varies | **false** | Critical — debug mode adds ~20% overhead |

These were applied via WP-CLI and are documented in [`setup-hetzner.md`](setup-hetzner.md).

---

## k6 Load Test Scenarios

All scenarios live in `k6/scenarios/`. The runner is `k6/run.js`, configured via env vars.

| Scenario | Purpose | Classic endpoint | Store API endpoint |
|----------|---------|------------------|-------------------|
| s1 | Add to cart | `POST /?wc-ajax=add_to_cart` | `POST /wp-json/wc/store/v1/cart/add-item/` |
| s2 | View cart | Classic fragments | `GET /wp-json/wc/store/v1/cart` |
| s3 | Update quantity | `POST /?wc-ajax=update_cart` | `POST /wp-json/wc/store/v1/cart/update-item/` |
| s4 | Apply coupon | `POST /?wc-ajax=apply_coupon` | `POST /wp-json/wc/store/v1/cart/apply-coupon/` |
| s5 | Remove coupon | `POST /?wc-ajax=remove_coupon` | `POST /wp-json/wc/store/v1/cart/remove-coupon/` |
| s6 | Checkout (place order) | `POST /?wc-ajax=checkout` | `POST /wp-json/wc/store/v1/checkout` |
| s7 | Full journey | Shop → add → coupon → checkout (with think time) | same |
| s8 | Realistic checkout | Randomised product, address, with 1–3s think time | same |
| s9 | Fidgety shopper | 10+ cart ops per session (add, remove, qty change, coupon swap) | same |
| s10 | Subscription checkout | Requires WC Subscriptions product | same |

### Design decisions

**Session + nonce acquired once per VU, not per iteration.**  
WooCommerce rotates nonces when the cart session state changes. We fetch all needed nonces *before* the iteration loop to prevent nonce refresh from polluting the target operation's timing.

**Only the target operation is tagged for comparison.**  
Setup requests (session init, nonce fetch) are intentionally excluded from the `target_duration` metric so we compare apples to apples.

**Stock management disabled on all products.**  
At 500 VU, real stock tracking would deplete inventory and start returning "out of stock" errors, corrupting the comparison. Disabled via `manage_stock=false`.

---

## Load Profiles

All profiles defined in `k6/run.js`:

| Profile | Stages | Total duration | Purpose |
|---------|--------|----------------|---------|
| `baseline` | 1 VU for 2 min | 2 min | Minimum-interference single-user baseline |
| `light` | Ramp to 50 VU, sustain 5 min | 7 min | Moderate traffic |
| `medium` | Ramp to 200 VU, sustain 5 min | 8 min | Busy store |
| `heavy` | Ramp to 500 VU, sustain 5 min | 9 min | High-traffic spike |
| `breaking` | Ramp to 500 VU for 10 min with thresholds | 10 min | Find the ceiling |

Baseline is run on the target server with no other k6 load. Higher profiles were run one-at-a-time, not in parallel, to avoid cross-test contamination.

---

## Puppeteer / Lighthouse Tests

### Cold vs Warm Cache

**Cold:** Fresh browser, empty cache. Adds item to cart, navigates to checkout, runs audit.  
**Warm:** Fresh browser, adds item to cart, navigates to checkout **twice** — the second visit serves all assets from disk cache.

Key script: [`lighthouse/audit-cached.mjs`](../lighthouse/audit-cached.mjs)

Lighthouse is launched on an **existing Puppeteer browser** with `disableStorageReset: true` to preserve the cache primed by the first visit. The default `disableStorageReset: false` wipes the cache between audits — that's why the original `audit-with-cart.mjs` script couldn't measure warm-cache performance.

### Real Web Vitals (bypass Lighthouse TTI)

Key script: [`lighthouse/real-vitals.mjs`](../lighthouse/real-vitals.mjs)

Lighthouse's TTI requires a **5-second quiet window** (no long tasks, ≤2 network requests). Combined with Chrome's **simulated** CPU throttling — which adds artificial idle gaps after each task rather than actually slowing the CPU — this penalises code-split architectures disproportionately.

Our approach: use `PerformanceObserver` to collect real browser metrics (FCP, LCP, CLS, long tasks, TBT) while applying `Emulation.setCPUThrottlingRate` via CDP. The CDP throttle applies genuine CPU scheduling constraints instead of artificial pauses. Compare at 1× / 2× / 4× rates.

See [3perf's research on Chrome throttling](https://3perf.com/blog/chrome-throttling/) for the full explanation.

### Checkout Interaction

Key script: [`lighthouse/interaction-cached.mjs`](../lighthouse/interaction-cached.mjs)

Measures what happens **after** the checkout page loads:

1. Wait for form to be interactive (`#billing_first_name` for classic, `input[id*="email"]` for blocks)
2. Fill 7 billing fields with realistic typing (30ms per keystroke)
3. Tab between fields (triggers AJAX on classic, state update on Store API)
4. Wait for order totals to recalculate
5. Count XHR/fetch requests during interaction

Store API makes more server calls during fill (5 vs classic's 1), but each one is faster.

### Stripe End-to-End

Key script: [`lighthouse/stripe-checkout-test.mjs`](../lighthouse/stripe-checkout-test.mjs)

Selects the Stripe payment method, fills the Stripe Payment Element iframe (card number, expiry, CVC), clicks Place Order, waits for redirect to `order-received`. Each run creates a real order via Stripe's test API.

Stripe Payment Element is rendered inside `iframe[src*="elements-inner-accessory-target"]` — we identify the visible one (non-zero height) and target its `input[name="number"]`, `name="expiry"`, `name="cvc"` children.

### Mobile Network Throttling

Key script: [`lighthouse/network-cached.mjs`](../lighthouse/network-cached.mjs)

Applies CDP `Network.emulateNetworkConditions` for:

- **Fast (no throttle):** `{ down: -1, up: -1, latency: 0 }`
- **4G:** `{ down: 4 Mbps, up: 3 Mbps, latency: 60ms }`
- **3G:** `{ down: 1.5 Mbps, up: 750 Kbps, latency: 300ms }`

Measured cold + warm on each profile for both classic and Store API.

### Multisite

Key script: [`lighthouse/multisite-test.mjs`](../lighthouse/multisite-test.mjs)

Multisite subdirectory mode breaks the single-site Puppeteer scripts because `fetch('/?wc-ajax=add_to_cart')` from inside `page.evaluate()` resolves against the network root domain, not the active subsite. The multisite adapter passes the subsite path explicitly: `fetch('/store1/?wc-ajax=add_to_cart')`.

---

## Data Generation

### Single-site heavy data

Script: [`scripts/generate-data.php`](../scripts/generate-data.php)

Generates directly via SQL (bypassing WC's create_* APIs) for speed. Key details:

- **HPOS orders require explicit IDs** shared with `wp_posts` `shop_order_placehold` rows. We create the placeholder posts first, then insert `wp_wc_orders` with matching IDs.
- Orders distributed across `wp_wc_orders` + `wp_wc_order_operational_data` (WC 10.6 schema). Earlier WC versions may use a single table.
- Dates randomised over 730 days (2 years) for realistic distribution.
- Order statuses weighted: 60% completed, 20% processing, 20% on-hold.

Targets:
- 100K users + ~2M usermeta (~20 keys per user)
- 200 products + lookup table entries
- 500K HPOS orders + ~2.8M order meta + ~3.6M items + ~25M item meta

### Multisite heavy data

Script: [`scripts/generate-data-multisite.php`](../scripts/generate-data-multisite.php)

Same approach, but orders go into per-subsite tables (`wp_2_wc_orders`, `wp_3_wc_orders`, …). Users and usermeta are shared network-wide.

Targets per multisite install:
- 100K shared users + 1.8M usermeta
- 60K orders × 8 subsites = 480K total orders
- ~6.7M order item meta across all stores

### Coupon volume scenarios

- **Low:** 50 coupons × 100 `_used_by` each = 5K postmeta rows
- **High:** 10K coupons × 50 `_used_by` each = 500K postmeta rows

Coupon codes are predictable: `PERFCPN00001` through `PERFCPN10000`. Tests use `PERFCPN00001` (low) or `PERFCPN05000` (mid-range, high scenario).

---

## What We Didn't Test

Worth calling out to save future researchers from thinking we missed something obvious:

- **Larger catalogs (10K+ products).** Our tests used 9–200 products. Large-catalog stores may see different patterns for product instance caching, search, and meta lookups.
- **Real payment processor latency variance.** We used Stripe's test mode from the same region. Geo-distributed Stripe traffic would add variance.
- **Geographic distribution.** All tests hit the server from the same Hetzner datacenter. CDN caching of Store API's chunks might benefit it more in production.
- **Write-heavy subscription renewals.** We tested checkout write volume, not cron-driven renewal batch jobs.
- **WooCommerce 10.7+.** Batch endpoints were added in 9.8, active optimization continues. The gap may narrow with newer versions.

---

## References

- [k6 load testing](https://k6.io/docs/)
- [Puppeteer](https://pptr.dev/)
- [Lighthouse programmatic usage](https://github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md#using-programmatically)
- [Chrome DevTools Protocol — Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/)
- [3perf — Chrome throttling is flawed](https://3perf.com/blog/chrome-throttling/)
- [WooCommerce HPOS architecture](https://developer.woocommerce.com/docs/high-performance-order-storage/)
- [Annexal — k6 VU to real user ratio](https://annexal.com/k6-vus-real-users/)

# Lighthouse & Puppeteer Scripts

Browser-side benchmarks. All scripts target two sites via environment variables.

## Install

```bash
npm install
```

## Environment Variables

All scripts accept:

| Var | Default | Meaning |
|-----|---------|---------|
| `CLASSIC_URL` | `https://classic.example.com` | Classic checkout site |
| `STOREAPI_URL` | `https://storeapi.example.com` | Store API (block checkout) site |
| `PRODUCT_ID` | `15` | Product ID to add to cart |
| `RUNS` | varies per script | Number of iterations per configuration |

For multisite, pass:

| Var | Default |
|-----|---------|
| `CLASSIC_MS_URL` | `https://classic-ms.example.com` |
| `STOREAPI_MS_URL` | `https://storeapi-ms.example.com` |
| `STORE` | `store1` |

---

## Scripts

### `audit-cached.mjs` — Cold vs warm-cache Lighthouse

Runs two Lighthouse audits per configuration:
1. Fresh browser, no cache
2. Same-browser with cache primed by a preliminary navigation

```bash
RUNS=3 node audit-cached.mjs all
# Or targeted:
node audit-cached.mjs storeapi mobile checkout
```

Output: `../results/session2/lighthouse-cached/<mode>-<device>-<page>/`

### `audit-with-cart.mjs` — Cold-only Lighthouse (Session 1)

Original baseline Lighthouse with cart items pre-populated. Launches a fresh browser per run.

### `network-cached.mjs` — Network throttle + warm cache

```bash
RUNS=3 node network-cached.mjs all
# Or:
node network-cached.mjs classic 4g
```

Profiles: `fast` (no throttle) / `4g` / `3g`.

### `interaction-cached.mjs` — Full checkout interaction

Measures page load → time-to-interactive → fill 7 billing fields → wait for order totals update. Cold + warm in sequence.

```bash
RUNS=5 node interaction-cached.mjs all
```

### `real-vitals.mjs` — Browser-native Web Vitals

Uses `PerformanceObserver` instead of Lighthouse's TTI algorithm. CDP CPU throttle at 1× / 2× / 4×. See [`../docs/methodology.md`](../docs/methodology.md) for the reasoning.

```bash
RUNS=5 node real-vitals.mjs all
# Single profile:
RUNS=3 node real-vitals.mjs storeapi 2x
```

Key metrics reported:
- `fcp` — First Contentful Paint
- `lcp` — Largest Contentful Paint
- `realTti` — Last long task end (or FCP if no long tasks after FCP)
- `tbt` — Sum of `duration - 50ms` over all long tasks
- `longTasks` — Count of tasks > 50ms

### `stripe-checkout-test.mjs` — End-to-end Stripe payment

Fills billing, selects Stripe, fills Stripe Payment Element iframe (card 4242, exp 12/30, CVC 123), clicks Place Order, waits for `order-received` redirect.

**Prerequisites:**
- Install `woocommerce-gateway-stripe` plugin on both sites
- Configure with Stripe test keys
- Complete the admin setup wizard once (initial PMC sync)

```bash
RUNS=5 node stripe-checkout-test.mjs all
```

### `multisite-test.mjs` — Multisite-aware suite

Runs the interaction, network, and vitals tests but uses subsite-prefixed paths for `wc-ajax` and REST endpoints.

```bash
STORE=store1 RUNS=5 node multisite-test.mjs all
# Individual tests:
node multisite-test.mjs interaction
node multisite-test.mjs network
node multisite-test.mjs vitals
```

### Legacy / exploratory scripts

- `checkout-interaction-test.mjs` — earlier version of interaction measurement, with returning-visitor quick test
- `network-analysis.mjs` — HTTP/2 multiplexing analysis
- `real-user-flow.mjs` — full shop → add → checkout → submit flow

---

## Output

All scripts write JSON to `../results/session2/<test-name>/`. The comparison tables in the docs are derived from these files.

To regenerate a table from raw JSON:

```bash
# Example: extract median checkout time from all multisite-heavy runs
python3 -c "
import json, os, glob
for f in sorted(glob.glob('../results/session2/multisite-heavy/*.json')):
    with open(f) as fh: d = json.load(fh)
    td = d.get('metrics',{}).get('target_duration',{})
    print(f'{os.path.basename(f):30s} median={td.get(\"med\",0):.0f}ms p95={td.get(\"p(95)\",0):.0f}ms')
"
```

# WooCommerce Performance Benchmarks

Open source test suite and raw data for the blog post [**"500 Concurrent Users on WooCommerce: A Store API vs Classic Checkout Load Test"**](https://blog.sobolew.ski/posts/woocommerce-store-api-benchmark).

This repository contains everything needed to replicate the benchmarks comparing **WooCommerce Store API (block checkout)** vs **classic wc-ajax (shortcode checkout)** on identical hardware.

---

## What's Tested

**Session 1 — Empty store, single-site:**
- k6 load tests: add-to-cart, apply coupon, checkout (1 VU → 500 VU)
- Lighthouse mobile + desktop (with cart items)
- PHP 8.3 vs 8.4 + JIT comparison
- Caching configurations (Redis, LSCache)
- Subscription checkout (WC Subscriptions)

**Session 2 — Real-world scenarios:**
- Returning visitors (warm browser cache) — Lighthouse + Puppeteer
- Network throttling with warm cache (no-throttle / 4G / 3G)
- Checkout interaction (page load → fill → update wait) — cold + warm
- Real Web Vitals via `PerformanceObserver` (avoids Lighthouse TTI inflation)
- End-to-end Stripe test payment (real `4242` test card)
- Multisite (subdirectory mode, 8 stores per install) — empty + heavy data
- Heavy data (500K orders, 100K users, 25M order item meta)
- Coupon volume impact (50 vs 10,000 coupons, 500K `_used_by` entries)

---

## Quick Start

### Prerequisites

- **Server:** Hetzner CCX33 (or equivalent 8 dedicated vCPU / 32GB RAM). See [`docs/setup-hetzner.md`](docs/setup-hetzner.md).
- **Local machine:** Node.js 18+, [k6](https://k6.io/docs/get-started/installation/), and Chrome (for Puppeteer).

### Run the k6 load tests

```bash
cd k6
./bench.sh classic s1 baseline          # 1 VU, 2 min — add to cart
./bench.sh storeapi s6 light            # 50 VU, 7 min — checkout
./bench.sh classic s6 heavy             # 500 VU, 9 min — checkout
```

URLs are configured via env vars:
```bash
CLASSIC_URL=https://classic.example.com \
STOREAPI_URL=https://storeapi.example.com \
./bench.sh storeapi s1 medium
```

### Run the Puppeteer/Lighthouse tests

```bash
cd lighthouse
npm install

# Returning visitor comparison (cold vs warm cache)
node audit-cached.mjs all

# Real Web Vitals at 1x / 2x / 4x CPU throttle
RUNS=5 node real-vitals.mjs all

# End-to-end Stripe checkout
node stripe-checkout-test.mjs all

# Multisite suite
node multisite-test.mjs all
```

---

## Repository Structure

```
.
├── docs/
│   ├── setup-hetzner.md          # Full server provisioning guide
│   ├── methodology.md            # What we measured and why
│   ├── results-session1.md       # Empty store findings
│   └── results-session2.md       # Heavy data + multisite + Stripe
├── k6/
│   ├── bench.sh                  # Test runner script
│   ├── run.js                    # Main k6 entry point
│   ├── config.js                 # URLs, products, coupons
│   ├── lib/                      # Shared helpers (classic.js, storeapi.js)
│   └── scenarios/                # s1–s10 scenarios
├── lighthouse/
│   ├── package.json              # Puppeteer + Lighthouse deps
│   ├── audit-cached.mjs          # Warm cache Lighthouse
│   ├── audit-with-cart.mjs       # Cold cache Lighthouse
│   ├── network-cached.mjs        # Network throttle + warm cache
│   ├── interaction-cached.mjs    # Checkout interaction timing
│   ├── real-vitals.mjs           # Browser-native Web Vitals
│   ├── stripe-checkout-test.mjs  # End-to-end Stripe payment
│   ├── multisite-test.mjs        # Multisite-aware test suite
│   ├── checkout-interaction-test.mjs
│   ├── network-analysis.mjs      # HTTP/2 + mobile throttling
│   └── real-user-flow.mjs        # Full user journey
├── scripts/
│   ├── generate-data.php         # Single-site data generator
│   └── generate-data-multisite.php
└── results/
    ├── session1/                 # Empty store raw JSON
    └── session2/                 # Heavy/multisite/etc raw JSON
```

---

## Key Findings (TL;DR)

### Empty store single-site
- **Classic wins on checkout:** 22–127% faster at every load level (1–500 VU)
- **Store API wins on cart ops under load:** P95 tail latency 5× more consistent at 500 VU
- **Classic wins on frontend:** 387KB vs 683KB page, 99–100 Lighthouse score vs 92–96

### Heavy data (500K orders, 100K users)
- Store API's checkout gap **narrows from 63% to 29%** at 50 VU
- At 200 VU, Store API checkout is actually **30% faster** with heavy data (warm object cache wins)
- Coupon volume has **zero impact** — indexed lookups are O(1)

### Multisite + heavy data (the most realistic scenario)
- **The gap nearly vanishes:** Checkout at 500 VU is Classic 5,019ms vs Store API **5,226ms** (+4%)
- **Classic add-to-cart collapses** at 500 VU: 14s median vs Store API's 871ms
- Store API checkout gets **13% faster** under load with heavy data than on empty single-site

### Returning visitors (warm cache)
- Store API's 683KB payload drops to **0KB** on return visits
- Warm 4G page load: Classic 911ms vs Store API 908ms (effectively tied)
- Store API scores **100 Lighthouse** on warm cache

### Lighthouse TTI is misleading
- Chrome's simulated CPU throttling adds artificial idle gaps after each task
- This inflates Store API's TTI by **84%** (7,804ms reported vs 4,243ms real)
- We used CDP `Emulation.setCPUThrottlingRate` for honest measurements
- See [3perf's research on Chrome throttling](https://3perf.com/blog/chrome-throttling/)

### Stripe payment
- Gateway latency (~5 seconds) dominates the checkout experience
- The architecture gap collapses from 22% to **5%** with real payment processing

---

## Hardware

All tests ran on a Hetzner CCX33 dedicated CPU instance:

- **8 dedicated AMD EPYC vCPU** (not shared)
- 32GB RAM
- 240GB NVMe SSD
- Falkenstein, Germany (EU-central)
- Cost: ~€50/month, hourly billing (~€9 for a 7-day test window)

Software stack:
- Ubuntu 24.04
- OpenLiteSpeed 1.8.5 + LSPHP 8.3 (60 workers, OPcache 256MB)
- MariaDB 10.11 (4GB buffer pool)
- Redis 7.0 (DB-isolated per instance)
- WordPress 6.9.4
- WooCommerce 10.6.2

---

## Replication Checklist

1. Provision Hetzner CCX33 (or equivalent dedicated CPU)
2. Follow [`docs/setup-hetzner.md`](docs/setup-hetzner.md) to install the stack
3. Create two WordPress instances with identical configuration
4. One configured with `[woocommerce_checkout]` shortcode (classic)
5. The other with `wp:woocommerce/checkout` block (Store API)
6. Enable **all** WC performance features (HPOS caching, REST API caching, etc.)
7. Disable `WP_DEBUG`, remote logging, and order attribution
8. Install the k6 nonce helper mu-plugin (see `docs/setup-hetzner.md`)
9. Run benchmarks from a separate machine (not the server itself)
10. Compare your results to those in `results/session*/`

---

## Caveats

- One server configuration — your hosting stack will produce different absolute numbers, but relative comparisons should hold.
- k6 virtual users aren't real users — Annexal's research suggests 1 k6 VU ≈ 20–30 real users.
- Tests hit the server from the same datacenter region — geographic latency is not simulated.

---

## Contributing

Found a bug in a test script? Have a better way to measure something? Results that contradict ours? Open an issue or PR.

In particular, we'd love verification on:
- Different hardware (shared vCPU, bare metal, AWS/GCP)
- Different PHP versions (8.4 showed regressions vs 8.3 in our tests)
- Different caching plugins (LiteSpeed Cache vs WP Rocket vs raw)
- Actual mobile devices (our TTI findings suggest Lighthouse simulation is unreliable)

---

## License

Dedicated to the public domain under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). See [LICENSE](LICENSE). Use freely, no attribution required.

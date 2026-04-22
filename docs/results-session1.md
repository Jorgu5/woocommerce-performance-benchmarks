# Session 1 Results — Empty Store, Single-Site

Initial benchmarks run April 2–7, 2026 on Hetzner CCX33 (8 dedicated vCPU, 32GB RAM). Empty product catalog (9 products), no order history, single-site WordPress install. Covers k6 server-side load, Lighthouse frontend, caching configurations, and PHP version comparison.

**For Session 2 (heavy data, multisite, Stripe, returning visitors) see [`results-session2.md`](results-session2.md).**

---

## Cart Operations: Store API Wins at Scale

At 1 VU, both return add-to-cart in ~80ms. At 500 VU, Store API pulls ahead:

| Operation | Classic | Store API |
|-----------|---------|-----------|
| Add to cart (500 VU) | 610ms | **578ms** (5% faster) |
| Apply coupon (500 VU) | 361ms | **302ms** (16% faster) |
| Coupon P95 (500 VU) | 3,546ms | **692ms** (5× more consistent) |

Store API's stateless REST releases PHP workers faster than classic's session-heavy `wc-ajax` calls, keeping P95 tail latency dramatically lower under load.

**Raw data:** [`results/session1/baseline/`](../results/session1/baseline/)

---

## Checkout: Classic Wins, Gap Widens Under Load

| Load | Classic | Store API | Gap |
|------|---------|-----------|-----|
| 1 VU | 185ms | 225ms | +22% |
| 50 VU | 1,642ms | 2,673ms | +63% |
| 200 VU | 2,107ms | 4,706ms | +123% |
| 500 VU | 2,643ms | 5,986ms | +127% |

Store API's checkout runs through REST routing, JSON schema validation, typed address object parsing, and full order serialization. Classic reads POST fields and returns `{"result":"success"}`.

**Failure rates at 500 VU:** Classic 4.4%, Store API 16.1%.

---

## The Fidgety Shopper Test (200 VU)

Simulated customers who do ~12 cart operations per session — add, remove, change quantity, swap coupons, then check out.

| Metric | Classic | Store API |
|--------|---------|-----------|
| Cart operation median | 94ms | 159ms |
| Cart operation P95 | 10,220ms | **268ms** (38× better) |
| Cart operation average | 1,890ms | 865ms |

Classic's median is better, but 5% of users waited 10+ seconds for a single cart operation. Store API's worst case was 268ms — a dramatic tail latency win. For subscription stores or comparison-heavy flows, this matters more than the median.

---

## Frontend Performance

Mobile Lighthouse, cart items present (cold cache):

| Metric | Classic | Store API |
|--------|---------|-----------|
| Performance Score | 99–100 | 92–96 |
| First Contentful Paint | 1.05s | 2.08s |
| Time to Interactive | 3,947ms | 8,606ms |
| Total Blocking Time | 95ms | 98ms |
| Cumulative Layout Shift | 0.000 | 0.002 |
| Page Size (transferred) | 387 KB | 683 KB |
| JS chunks loaded | ~15 | ~120 |

Store API ships React, the block editor runtime, the checkout block, and Stripe's payment element — 683KB across ~120 chunks. Classic ships jQuery, a few WooCommerce scripts, the payment form — 387KB in ~15 files.

**Important caveat:** Store API's TTI of 8,606ms is inflated by Lighthouse's simulated CPU throttling. Real TTI on a mid-range phone is closer to 3,885ms. See Session 2 results for the breakdown.

**Raw data:** [`results/session1/frontend/`](../results/session1/frontend/)

---

## Caching Configurations (50 VU)

Tested with four stack combinations on the checkout scenario:

| Config | Classic | Store API | Gap |
|--------|---------|-----------|-----|
| A: No object cache, no page cache | 2,124ms | 2,451ms | +15.4% |
| B: Redis object cache only | 1,852ms | 2,019ms | +9.0% |
| C: LSCache only (no Redis) | 1,798ms | 1,923ms | +7.0% |
| D: Redis + LSCache | 1,711ms | 1,770ms | **+3.4%** |

With the full cache stack, the Store API → classic gap narrows from 15% to just 3.4%. Redis disproportionately benefits Store API because its REST methods make more internal `wc_get_product()` and schema validation calls that hit the object cache.

**Raw data:** [`results/session1/optimizations/`](../results/session1/optimizations/)

---

## PHP Version Comparison

PHP 8.4 + JIT was 10–18% slower than PHP 8.3 for WooCommerce workloads.

| Scenario | PHP 8.3 | PHP 8.4 (JIT off) | PHP 8.4 (JIT on) |
|----------|---------|-------------------|-------------------|
| Add to cart (1 VU) | 80ms | 92ms (+15%) | 98ms (+22%) |
| Checkout (1 VU) | 185ms | 216ms (+17%) | 225ms (+22%) |

Web requests complete in under 100ms — too fast for JIT's tracing profiler to find hot loops worth compiling. You pay profiling overhead without gaining compilation benefit. Stick with 8.3.

**Raw data:** [`results/session1/optimizations/`](../results/session1/optimizations/)

---

## Hidden WooCommerce Performance Switches

Several performance features ship **off** by default. Without enabling them, Store API tested ~9% slower across the board. With them on, Store API matched classic on cart operations.

| Feature | Default | Required setting | Impact |
|---------|---------|-----------------|--------|
| HPOS datastore caching | off | **on** | Cache order objects in Redis |
| REST API caching | off | **on** | Cache REST responses |
| Product instance caching | off | **on** | Skip redundant product hydration |
| Order attribution | on | **off** | Removes tracking overhead |
| `WP_DEBUG` | varies | **false** | ~20% overhead just for being on |

These are documented in the WooCommerce source but not prominently in the admin UI. Applied via WP-CLI in [`docs/setup-hetzner.md`](setup-hetzner.md).

---

## Mobile Network Throttling (cold cache)

Checkout page load time across network conditions:

| Network | Classic | Store API | Gap |
|---------|---------|-----------|-----|
| No throttle | 1,095ms | 1,120ms | +2% |
| 4G (4 Mbps / 60ms RTT) | 1,657ms | 2,288ms | +38% |
| 3G (1.5 Mbps / 300ms RTT) | 3,498ms | 4,810ms | +38% |

Store API's 683KB payload hurts on bandwidth-constrained networks. On WiFi/fast 4G, HTTP/2 multiplexing closes much of the gap — 120 parallel chunks download in parallel streams.

**Important:** This is the **cold cache** story. Session 2 shows that warm cache effectively eliminates the gap. See [`results-session2.md`](results-session2.md).

---

## Subscription Checkout (WC Subscriptions 8.6)

With a subscription product in cart, both platforms take a similar hit from the extra validation and recurring payment setup:

| Load | Classic | Store API |
|------|---------|-----------|
| 1 VU | 312ms | 378ms |
| 50 VU | 2,198ms | 3,417ms |
| 200 VU | 3,246ms | 7,103ms |

The classic → Store API gap is similar to non-subscription checkout. WC Subscriptions doesn't fundamentally change the architecture comparison.

**Raw data:** [`results/session1/subscriptions/`](../results/session1/subscriptions/)

---

## Key Takeaways

1. **Store API wins on cart ops at scale** — P95 consistency is dramatically better (5× on coupons, 38× on fidgety shopper).
2. **Classic wins on checkout at every load level** on empty data — 22% at baseline, up to 127% at 500 VU.
3. **Classic wins on frontend** by a wide margin on cold cache — 9× smaller page, 2× faster FCP, 2× better Lighthouse score.
4. **PHP 8.4 + JIT is a regression for WooCommerce** — stick with PHP 8.3.
5. **Enabling WC performance flags closes most of the gap** — they're not optional if you want a fair fight.

For the more interesting findings — what happens with warm cache, heavy data, multisite, and real payment processing — see Session 2.

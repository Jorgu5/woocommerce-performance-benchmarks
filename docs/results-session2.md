# Session 2 Results — Returning Visitors, Real Vitals, Stripe, Multisite, Heavy Data

Additional benchmark data collected April 9–14, 2026 on the same Hetzner CCX33 (8 dedicated AMD EPYC vCPU / 32GB RAM). All tests run against WooCommerce 10.6.2 with the same configuration as Session 1 unless noted.

**Tags:** WooCommerce, Store API, Classic Checkout, Block Checkout, Performance, Lighthouse, Puppeteer, k6, Hetzner, Returning Visitors, Warm Cache, Stripe, Payment Gateway, Multisite, Subdirectory Multisite, Multi-Tenant, Heavy Data, 500K Orders, Coupon Validation, Real Web Vitals, TTI, Chrome Throttling, CDP, WordPress 6.9

---

## 1. Cached (Returning Visitor) Lighthouse Audit

**What we tested:** Lighthouse Performance scores on first visit (cold browser cache) vs return visit (warm browser cache). WC Payments deactivated on both to isolate checkout architecture from Sift fraud detection.

**Script:** `audit-cached.mjs`

### Mobile Checkout — Cold vs Warm (no WC Payments)

| Metric | Classic Cold | Classic Warm | SA Cold | SA Warm |
|--------|------------|-------------|---------|---------|
| Score | 100 | 100 | 96 | 100 |
| FCP | 1,351ms | 950ms | 2,169ms | 1,189ms |
| LCP | 1,351ms | 963ms | 2,185ms | 1,189ms |
| TTI | 1,884ms | 1,027ms | 8,765ms | 1,455ms |
| TBT | 2ms | 3ms | 83ms | 66ms |
| Size | 75KB | 38KB | 681KB | 63KB |

**Cache benefit (TTI):** Classic 45% improvement. Store API **83%** improvement.

### With WC Payments + Sift on Both (gateway forced active)

| Metric | Classic Cold | Classic Warm | SA Cold | SA Warm |
|--------|------------|-------------|---------|---------|
| Score | 97 | 72 | 91 | 72 |
| TTI | 4,514ms | 3,237ms | 9,791ms | 3,665ms |
| TBT | 51ms | 1,990ms | 207ms | 1,984ms |

Sift's fraud detection script (`cdn.sift.com/s.js`) causes ~2,000ms TBT on warm cache for both architectures. On cold cache, Sift runs after TTI and doesn't impact the score. On warm cache, all local scripts load instantly from disk, so Sift's execution falls within the FCP→TTI window.

### WC Payments Sift Bug (discovered during testing)

Classic checkout loads WC Payments' `checkout.js` (which includes Sift) via the `woocommerce_after_checkout_form` action **without checking if the gateway is enabled**. Block checkout correctly checks `is_active()` → `is_available()` → `is_connected()` and skips disabled/disconnected gateways. This means classic checkout loads Sift even when WC Payments is active but the gateway is disabled — a real-world scenario for stores testing or using a different payment provider.

---

## 2. Mobile Network — Returning Visitor Page Load

**What we tested:** Checkout page load time on no-throttle, 4G (4Mbps/60ms RTT), and 3G (1.5Mbps/300ms RTT) with cold vs warm browser cache. CDP network throttling, mobile viewport.

**Script:** `network-cached.mjs`

| Network | C Cold | C Warm | SA Cold | SA Warm | Cold Gap | Warm Gap |
|---------|--------|--------|---------|---------|----------|----------|
| No throttle | 1,095ms | 870ms | 1,120ms | **832ms** | +2% | **-4%** |
| 4G | 1,657ms | 911ms | 2,288ms | **908ms** | +38% | **0%** |
| 3G | 3,498ms | 1,147ms | 4,810ms | 1,274ms | +38% | +11% |

**Transfer size:** Classic 316KB cold / 2KB warm. Store API 634KB cold / **0KB** warm.

**Key finding:** On warm cache, Store API matches or beats classic on every network condition. The 634KB cold payload penalty disappears entirely on return visits. Even on 3G, the gap shrinks from 38% to 11%.

---

## 3. Checkout Interaction — Returning Visitor

**What we tested:** Full checkout interaction (page load → form ready → fill fields → update wait) with cold vs warm cache. Puppeteer, no CPU throttling.

**Script:** `interaction-cached.mjs`

| Metric | C Cold | C Warm | SA Cold | SA Warm |
|--------|--------|--------|---------|---------|
| Page load | 1,032ms | 1,169ms | 1,103ms | **819ms** |
| TTI | 7ms | 7ms | 1,008ms | 1,008ms |
| Field fill | 4,873ms | 4,913ms | 5,372ms | 5,325ms |
| Update wait | 2,004ms | 2,007ms | **1,005ms** | **1,004ms** |
| Total interaction | 6,881ms | 6,925ms | **6,377ms** | **6,331ms** |
| Server calls | 1 | 1 | 5 | 5 |

**Key finding:** Post-load interaction metrics (fill, update wait, server calls) are unchanged by caching — they're server-side work. Only page load benefits from warm cache. Store API's warm page load is 30% faster than classic (819ms vs 1,169ms).

---

## 4. Real Web Vitals — TTI Investigation

**What we tested:** Lighthouse reports TTI of ~8,600ms for Store API mobile. We investigated using `PerformanceObserver` with CDP CPU throttling at 1x (desktop), 2x (mid-range phone), and 4x (Lighthouse mobile).

**Script:** `real-vitals.mjs`

### Why Lighthouse TTI Is Inflated

Lighthouse TTI requires a **5-second quiet window** (no long tasks, ≤2 network requests). Store API's 66 code-split chunks each become just-above-50ms long tasks at 4x CPU throttle. They're spread across 5,767ms–8,075ms, preventing the quiet window from starting until ~8,233ms. Each individual task is small (69–141ms), but their spacing denies the 5-second gap.

Classic ships fewer, larger bundles that evaluate in bigger batches, leaving longer gaps between tasks.

### Chrome's Simulated Throttling Is Fundamentally Flawed for Code-Split Architectures

This finding is corroborated by [Ivan Akulov's research on Chrome throttling](https://3perf.com/blog/chrome-throttling/). Chrome DevTools (and by extension Lighthouse) doesn't actually slow down the CPU. Instead, it **adds artificial idle pauses after each task** to simulate slower execution. A task that takes 20ms gets 60ms of artificial idle appended to simulate 4x = 80ms total.

The problem: these artificial pauses create fake gaps in the timeline. For Store API's 66 small chunks, each gets an inflated gap after it. A real slow CPU would execute them back-to-back; Chrome's simulation spreads them across a much longer window. The TTI algorithm then sees these inflated gaps as the timeline being "busy" for 8+ seconds, when on a real device the chunks would finish in rapid succession.

This disproportionately penalizes code-split architectures (many small files) vs monolithic bundles (few large files). Classic's ~15 scripts produce ~15 artificial gaps. Store API's ~66 scripts produce ~66 gaps, inflating the timeline by 3-4x more.

**Evidence from our tests:**

| Measurement Method | SA Cold TTI | Inflation vs Real |
|--------------------|-------------|-------------------|
| Real CDP `setCPUThrottlingRate(4)` | 4,243ms | Baseline |
| Lighthouse simulated 4x | **7,804ms** | **+84%** |

We used `Emulation.setCPUThrottlingRate` via CDP, which applies actual CPU scheduling constraints rather than artificial pauses. This produces results closer to real device behavior, showing the 84% inflation that Lighthouse's simulation introduces for Store API specifically.

### Real TTI by CPU Throttle (cold cache, mobile)

| Throttle | Classic Real TTI | SA Real TTI | Gap | Lighthouse TTI (SA) |
|----------|-----------------|-------------|-----|---------------------|
| 1x (desktop) | 384ms | 968ms | 2.5x | — |
| **2x (mid-range)** | **400ms** | **3,885ms** | **9.7x** | — |
| 4x (Lighthouse) | 2,486ms | 4,243ms | 1.7x | **7,804ms** |

At 2x (realistic mid-range phone), Store API has a genuine ~3.5s gap between FCP and full responsiveness. At 1x, both are instant. At 4x, Lighthouse's quiet window algorithm inflates SA from 4,243ms real to 7,804ms reported.

### Warm Cache — All Throttle Levels

| Throttle | Classic Warm TTI | SA Warm TTI |
|----------|-----------------|-------------|
| 1x | 308ms | 316ms |
| 2x | 316ms | 320ms |
| 4x | 565ms | 673ms |

**On return visits, both are under 700ms at every throttle level.** Zero long tasks at 1x and 2x. The architecture difference vanishes.

---

## 5. Stripe Payment Processing

**What we tested:** End-to-end checkout with real Stripe test payment (4242 test card). WooCommerce Stripe Gateway 10.5.3 in test mode. Puppeteer fills billing fields, Stripe card element, and clicks Place Order.

**Script:** `stripe-checkout-test.mjs`

### Stripe Checkout Comparison (5 runs, median)

| Step | Classic | Store API | Diff |
|------|---------|-----------|------|
| Page load | 3,218ms | **2,695ms** | SA 16% faster |
| Time to interactive | **8ms** | 1,509ms | Classic instant |
| Fill billing | 3,428ms | 3,837ms | Similar |
| Update wait | 2,007ms | **1,012ms** | SA 50% faster |
| Fill Stripe card | 2,747ms | 2,746ms | Identical |
| **Submit → Confirm** | **5,034ms** | 5,293ms | Classic 5% faster |
| **Total checkout** | **16,442ms** | 17,222ms | Classic 5% faster |

Success rate: Classic 5/5, Store API 4/5.

**Key finding:** Stripe payment adds ~5 seconds to Place Order on both architectures (vs <200ms with COD). This equalizes the checkout gap — with COD, classic was 22% faster. With Stripe, only **5%**. Payment gateway latency dominates.

---

## 6. Multisite Performance

**What we tested:** Two WordPress multisite installations (subdirectory mode) with 8 WooCommerce stores each. Same server, same Redis (isolated DB indices), same OLS config. One multisite uses classic shortcode checkout, the other uses block checkout.

**Setup:**
- `classic-ms.example.com/store{1-8}/` — shortcode checkout
- `storeapi-ms.example.com/store{1-8}/` — block checkout
- 5 products per store, COD payment, flat rate shipping
- Redis DB 2 (classic-ms) and DB 3 (storeapi-ms)
- All WC performance features enabled

**Script:** `multisite-test.mjs` (Puppeteer), k6 with multisite URLs

### Server-Side (k6) — Multisite vs Single-site

#### Add to Cart (median response time)

| Load | C Single | C Multi | C Overhead | SA Single | SA Multi | SA Overhead |
|------|----------|---------|------------|-----------|----------|-------------|
| 1 VU | 80ms | 80ms | 0% | 80ms | 82ms | +2% |
| 50 VU | 243ms | 252ms | +4% | 252ms | 264ms | +5% |
| 200 VU | 356ms | 340ms | -4% | 354ms | 366ms | +3% |
| 500 VU | 610ms | 688ms | +13% | 578ms | 923ms | +60% |

#### Checkout (median response time)

| Load | C Single | C Multi | C Overhead | SA Single | SA Multi | SA Overhead |
|------|----------|---------|------------|-----------|----------|-------------|
| 1 VU | 185ms | 190ms | +3% | 225ms | 232ms | +3% |
| 50 VU | 1,642ms | 1,855ms | +13% | 2,673ms | 2,761ms | +3% |
| 200 VU | 2,107ms | 3,179ms | +51% | 4,706ms | 4,950ms | +5% |
| 500 VU | 2,643ms | **FAIL** | — | 5,986ms | 30,001ms | — |

#### Failure Rates at 500 VU

| Operation | C Single | C Multi | SA Single | SA Multi |
|-----------|----------|---------|-----------|----------|
| Add to cart | 0% | **16.3%** | 0% | 2.4% |
| Checkout | 4.4% | **100%** | 16.1% | 100% |

### Frontend (Puppeteer) — Multisite Interaction

| Metric | C Cold | C Warm | SA Cold | SA Warm |
|--------|--------|--------|---------|---------|
| Page load | 885ms | 1,158ms | 1,110ms | **788ms** |
| TTI | 7ms | 5ms | 1,006ms | 1,005ms |
| Update wait | 2,005ms | 2,005ms | **1,009ms** | **1,004ms** |
| Total interaction | 6,781ms | 6,777ms | **6,276ms** | **6,067ms** |

### Network Throttling — Multisite

| Network | C Cold | C Warm | SA Cold | SA Warm | Cold Gap | Warm Gap |
|---------|--------|--------|---------|---------|----------|----------|
| No throttle | 869ms | 856ms | 1,101ms | **817ms** | +27% | **-5%** |
| 4G | 925ms | 909ms | 2,229ms | **883ms** | +141% | **-3%** |
| 3G | 1,769ms | 1,195ms | 4,712ms | 1,259ms | +166% | +5% |

### Real Vitals — Multisite (2x CPU)

| Metric | C Cold | C Warm | SA Cold | SA Warm |
|--------|--------|--------|---------|---------|
| FCP | 404ms | 324ms | 920ms | 320ms |
| Real TTI | 404ms | 324ms | 3,812ms | **320ms** |
| TBT | 0ms | 0ms | 51ms | 0ms |
| Transfer | 39KB | 1KB | 625KB | 0KB |

### Multisite Summary

**Up to 200 VU:** Multisite adds 0–5% overhead on most operations. The exception is classic checkout at 200 VU (+51%), where session-based DB queries contend with shared tables. Store API's stateless REST approach is more multisite-friendly (+5%).

**At 500 VU:** Multisite checkout collapses completely on both architectures (100% failure). Add-to-cart survives but with degraded performance. The bottleneck is PHP worker exhaustion compounded by `switch_to_blog()` cache flushes and shared table locks. Store API handles cart operations better (2.4% vs 16.3% failure rate) because it avoids session table contention.

**Frontend:** Identical to single-site. Multisite overhead is server-side only.

---

## Key Takeaways for the Article

### Returning Visitors Change the Narrative
- Store API's 683KB cold payload becomes 0KB on return visits
- On warm cache with 4G, both load in ~910ms — effectively tied
- The article's "3G: classic wins" is only true for first-time visitors
- Store API's cache benefit is 2x larger (83% vs 45% TTI improvement)

### Lighthouse TTI Is Misleading for Store API
- Lighthouse reports 8,600ms TTI due to the 5-second quiet window algorithm
- Real TTI (last long task end) at 4x CPU: 4,243ms — 45% lower
- Real TTI at 2x (actual mid-range phone): 3,885ms
- On warm cache: both under 700ms at any throttle level
- Recommend presenting both Lighthouse TTI and Real TTI in the article

### Stripe Equalizes the Checkout Gap
- With COD: classic is 22–127% faster at checkout
- With Stripe: classic is only **5% faster** (5,034ms vs 5,293ms total)
- Stripe API round-trip (~4–5s) dominates, making architecture differences marginal
- Both architectures handle Stripe identically for the card filling step

### Multisite Is Fine Until It Isn't
- 0–5% overhead at normal traffic (1–200 VU)
- Store API is more multisite-friendly than classic under load
- Classic checkout is particularly vulnerable (+51% at 200 VU, 100% failure at 500 VU)
- Store API's stateless approach avoids session table contention
- At 500 VU: both collapse — this is a server sizing issue, not architecture

---

## Test Scripts Created

| Script | Purpose |
|--------|---------|
| `audit-cached.mjs` | Lighthouse cold vs warm cache comparison |
| `network-cached.mjs` | Network throttling with warm cache |
| `interaction-cached.mjs` | Checkout interaction with warm cache |
| `real-vitals.mjs` | Real Web Vitals via PerformanceObserver at 1x/2x/4x CPU |
| `stripe-checkout-test.mjs` | End-to-end Stripe test payment checkout |
| `multisite-test.mjs` | Multisite-aware interaction + network + vitals suite |

---

## 7. Heavy Data — Large Store Simulation

**What we tested:** Performance with realistic data volumes — 500K orders, 25M order item meta, 100K users, 2M usermeta, 200 products. Then coupon validation with low (50 coupons, 5K `_used_by`) vs high (10K coupons, 500K `_used_by`) coupon volumes.

**Data volumes per instance:**

| Table | Row Count | Size |
|-------|-----------|------|
| wp_woocommerce_order_itemmeta | 25M | 1.5GB data + 1.2GB idx |
| wp_woocommerce_order_items | 3.6M | 214MB |
| wp_wc_orders_meta | 2.8M | 212MB |
| wp_usermeta | 2.1M | 136MB |
| wp_wc_orders | 500K | 61MB |
| wp_posts | 500K+ | 78MB |
| wp_users | 100K | 15MB |
| wp_postmeta (high coupons) | 568K | varies |

### Add to Cart — Empty vs Heavy Data

| Load | Empty C | Heavy C | C Impact | Empty SA | Heavy SA | SA Impact |
|------|---------|---------|----------|----------|----------|-----------|
| 1 VU | 80ms | 88ms | +10% | 80ms | 93ms | +16% |
| 50 VU | 243ms | 320ms | +32% | 252ms | 374ms | +48% |

### Checkout — Empty vs Heavy Data

| Load | Empty C | Heavy C | C Impact | Empty SA | Heavy SA | SA Impact |
|------|---------|---------|----------|----------|----------|-----------|
| 1 VU | 185ms | 219ms | +18% | 225ms | 266ms | +18% |
| 50 VU | 1,642ms | 1,986ms | +21% | 2,673ms | 2,559ms | -4% |

**Key finding:** Heavy data adds 10-48% overhead depending on operation and load level. Store API is hit harder on cart operations (+48% vs +32% at 50 VU) but performs relatively better on checkout under load (-4% vs +21% at 50 VU). The classic→SA checkout gap narrows from 63% (empty) to 29% (heavy data) at 50 VU.

### Coupon Apply — Low vs High Coupon Volume

| Scenario | Classic Med | Classic P95 | SA Med | SA P95 |
|----------|------------|-------------|--------|--------|
| Empty store, 1 VU | 77ms | 86ms | 76ms | 86ms |
| 50 coupons (5K used_by), 1 VU | 85ms | 99ms | 88ms | 114ms |
| 10K coupons (500K used_by), 1 VU | 85ms | 95ms | 87ms | 108ms |
| Empty store, 50 VU | 227ms | 275ms | 220ms | 267ms |
| 50 coupons (5K used_by), 50 VU | 297ms | 363ms | 329ms | 402ms |
| 10K coupons (500K used_by), 50 VU | 294ms | 362ms | 297ms | 388ms |

**Key finding:** Coupon volume is a non-issue. Going from 50 to 10,000 coupons with 500K `_used_by` postmeta entries produces zero measurable performance difference. WooCommerce's coupon validation uses `(post_id, meta_key)` indexed lookups that are O(1) regardless of total table size. The +10-30% overhead seen is from the general data load (500K orders, 100K users), not the coupons.

### Full Load Level Comparison — Empty vs Heavy Data

#### Add to Cart

| Load | Empty C | Heavy C | C Impact | Empty SA | Heavy SA | SA Impact | Empty Gap | Heavy Gap |
|------|---------|---------|----------|----------|----------|-----------|-----------|-----------|
| 1 VU | 80ms | 88ms | +10% | 80ms | 93ms | +16% | 0% | +6% |
| 50 VU | 243ms | 320ms | +32% | 252ms | 374ms | +48% | +4% | +17% |
| 200 VU | 356ms | 408ms | +15% | 354ms | 456ms | +29% | -1% | +12% |
| 500 VU | 610ms | **5,275ms** | **+765%** | 578ms | 1,856ms | +221% | -5% | **-65%** |

At 500 VU with heavy data, classic collapses (5.2s median, 60s P95) while Store API degrades more gracefully (1.8s). The `wp_posts` table at 500K rows + session table locks destroy classic's performance. Store API's stateless approach is far more resilient.

#### Checkout

| Load | Empty C | Heavy C | C Impact | Empty SA | Heavy SA | SA Impact | Empty Gap | Heavy Gap |
|------|---------|---------|----------|----------|----------|-----------|-----------|-----------|
| 1 VU | 185ms | 219ms | +18% | 225ms | 266ms | +18% | +22% | +21% |
| 50 VU | 1,642ms | 1,986ms | +21% | 2,673ms | 2,559ms | -4% | +63% | **+29%** |
| 200 VU | 2,107ms | 2,356ms | +12% | 4,706ms | **3,303ms** | **-30%** | +123% | **+40%** |
| 500 VU | 2,643ms | 5,424ms | +105% | 5,986ms | 7,128ms | +19% | +126% | **+31%** |

The checkout gap between classic and Store API **halves with heavy data**: from +123% to +40% at 200 VU, and from +126% to +31% at 500 VU. Store API checkout actually gets 30% faster at 200 VU with heavy data — the warm object cache from the large dataset benefits Store API's internal `wc_get_product()` and schema validation calls.

#### Why Heavy Data Changes the Picture

1. **Classic's session table becomes a bottleneck.** `wp_woocommerce_sessions` with 500K orders generates more active sessions and row-level lock contention. Store API is stateless.

2. **Store API benefits more from object caching.** With 100K users and 500K orders, Redis stays warm with frequently-accessed customer and product data. Store API makes more `wp_cache_get()` calls than classic, so it benefits disproportionately.

3. **The `wp_posts` table at 500K rows hurts classic cart operations.** Classic's `wc-ajax` endpoints still query `wp_posts` for product lookups. Store API uses the `wc_product_meta_lookup` table which is smaller and better indexed.

4. **Failure rates at 500 VU:** Classic add-to-cart fails 6% of requests. Store API add-to-cart fails 10% — both struggling, but classic's failures are more catastrophic (5.2s median vs 1.8s).

### Multisite + Heavy Data (480K orders, 100K users, 8 stores)

The most realistic scenario: multisite with production-scale data on each subsite.

**Data per multisite instance:** 100K shared users, 2M usermeta, 60K orders per store × 8 stores = 480K orders, ~6.7M order item meta.

#### Add to Cart — 4-Way Comparison (median)

| Load | Empty Single C | Empty Single SA | Heavy Multi C | Heavy Multi SA | ES Gap | HM Gap |
|------|---------------|----------------|--------------|---------------|--------|--------|
| 1 VU | 80ms | 80ms | 284ms | 82ms | 0% | **-71%** |
| 50 VU | 243ms | 252ms | 258ms | 265ms | +4% | +3% |
| 200 VU | 356ms | 354ms | 379ms | **323ms** | -1% | **-15%** |
| 500 VU | 610ms | 578ms | **14,055ms** | **871ms** | -5% | **-94%** |

At 500 VU, classic collapses to 14s median while Store API stays under 1s. The gap reverses from near-equal to **Store API 94% faster**.

#### Checkout — 4-Way Comparison (median)

| Load | Empty Single C | Empty Single SA | Heavy Multi C | Heavy Multi SA | ES Gap | HM Gap |
|------|---------------|----------------|--------------|---------------|--------|--------|
| 1 VU | 185ms | 225ms | 190ms | 238ms | +22% | +25% |
| 50 VU | 1,642ms | 2,673ms | 2,535ms | 3,371ms | +63% | +33% |
| 200 VU | 2,107ms | 4,706ms | 3,478ms | **4,079ms** | +123% | **+17%** |
| 500 VU | 2,643ms | 5,986ms | 5,019ms | **5,226ms** | +126% | **+4%** |

The checkout gap narrows from +126% (empty single) to **+4%** (heavy multisite) at 500 VU.

#### Overhead: Heavy Multisite vs Empty Single-site

| Operation | Load | Classic Overhead | SA Overhead |
|-----------|------|-----------------|-------------|
| Add to Cart | 50 VU | +6% | +5% |
| Add to Cart | 200 VU | +6% | **-9%** |
| Add to Cart | 500 VU | **+2,204%** | +51% |
| Checkout | 50 VU | +54% | +26% |
| Checkout | 200 VU | +65% | **-13%** |
| Checkout | 500 VU | +90% | **-13%** |

Store API checkout is **13% faster** on heavy multisite than on empty single-site at 200-500 VU. Classic gets 65-90% slower. The combination of heavy data + multisite overhead makes classic's session-based architecture a bottleneck, while Store API's stateless REST approach benefits from the warm object cache.

#### Why Store API Wins on Heavy Multisite

1. **No session table contention.** Classic's `wp_woocommerce_sessions` table is per-subsite but shares the DB connection pool. With 8 active stores, session INSERT/UPDATE row locks compound. Store API is stateless.

2. **Object cache leverage.** Store API makes more `wp_cache_get()` calls for product data, cart validation, and schema lookups. With 100K users and 60K orders warming the cache, these calls hit Redis instead of MySQL. Classic bypasses the object cache for many session-bound operations.

3. **Smaller per-request DB footprint.** Store API's REST endpoints do targeted queries. Classic's `update_order_review` AJAX call triggers full cart recalculation with multiple JOINs across `wp_posts`, `wp_postmeta`, and order tables — all of which are heavier with data.

4. **`wp_posts` table bloat.** Each store has ~60K `shop_order_placehold` posts + product posts. Classic's cart operations still query `wp_posts` for lookups. Store API uses `wc_product_meta_lookup` (smaller, dedicated index).

---

## Raw Results

All raw data in `tests/performance/results/`:
- `lighthouse-cached/` — Lighthouse JSON reports (cold + warm)
- `interaction-cached/` — Puppeteer interaction JSON
- `network-cached/` — Network throttling JSON
- `real-vitals/` — Web Vitals JSON
- `stripe-checkout/` — Stripe checkout JSON + screenshots
- `multisite/` — All multisite results (k6 JSON + Puppeteer JSON)
- `tti-investigation/` — CPU throttle comparison data
- `heavy-data/` — All heavy data + coupon benchmark results

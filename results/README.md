# Raw Results

All k6 summary JSONs and Lighthouse reports from our test runs. These are the files the comparison tables in `docs/results-session1.md` and `docs/results-session2.md` are derived from.

## Structure

```
results/
├── session1/
│   ├── baseline/              # Empty store k6 runs (s1–s10, all profiles)
│   ├── frontend/              # Lighthouse audits (mobile + desktop, cart + checkout)
│   ├── optimizations/         # Caching configs (A/B/C/D), PHP 8.3 vs 8.4
│   └── subscriptions/         # WC Subscriptions checkout
└── session2/
    ├── heavy-data/            # 500K orders, k6 baseline through heavy
    ├── multisite/             # Empty multisite, 8 subsites
    ├── multisite-heavy/       # 480K orders across 8 subsites
    ├── lighthouse-cached/     # Cold vs warm Lighthouse
    ├── network-cached/        # Network throttle + warm cache
    ├── interaction-cached/    # Checkout interaction timing
    ├── real-vitals/           # PerformanceObserver-based Web Vitals
    ├── stripe-checkout/       # End-to-end Stripe payment runs
    └── tti-investigation/     # 1x vs 2x vs 4x CPU throttle comparison
```

## File naming conventions

### k6 results

`<mode>-<scenario>-<profile>.json` — e.g. `classic-s6-heavy.json` = classic checkout at 500 VU.

For experiments with variants, a suffix is appended: `classic-s6-light-v2.json`, `storeapi-s1-light-optimized.json`.

### Lighthouse reports

Per-configuration directories contain:
- `lhr-run1.json`, `lhr-run2.json`, `lhr-run3.json` — full Lighthouse Result JSON (large)
- `summary.json` — our condensed median metrics across runs

Session 2's cold-vs-warm audits split into `cold-run*` and `warm-run*`.

## How to re-aggregate

Each k6 JSON has the same structure. The key path for our "target duration" metric is:

```
metrics.target_duration.med   // median
metrics.target_duration.p(95) // P95
metrics.target_duration.p(99) // P99
metrics.http_req_failed.rate  // failure rate (0–1)
```

Example one-liner to extract medians across a directory:

```bash
python3 -c "
import json, glob, os
for f in sorted(glob.glob('session2/multisite-heavy/*.json')):
    with open(f) as fh: d = json.load(fh)
    td = d.get('metrics',{}).get('target_duration',{})
    hf = d.get('metrics',{}).get('http_req_failed',{})
    name = os.path.basename(f).replace('.json','')
    print(f'{name:35s}  med={td.get(\"med\",0):>6.0f}ms  p95={td.get(\"p(95)\",0):>6.0f}ms  fail={(hf.get(\"rate\",0) or 0)*100:.1f}%')
"
```

## File sizes

Raw results total ~34 MB. k6 summaries are small (~5 KB each). Lighthouse Result JSONs are larger (400–500 KB each) because they include traces, network requests, and audit details.

We commit them to make verification possible — anyone can re-run our aggregation scripts and compare to our published tables, or use the same data to build alternative visualisations.

## Verifying our tables

The tables in the docs claim specific medians and percentiles. You can verify them directly against the raw data:

```bash
# Verify "Classic checkout at 500 VU on empty single-site = 2,643ms median"
python3 -c "
import json
with open('session1/baseline/classic-s6-heavy.json') as f:
    d = json.load(f)
print(d['metrics']['target_duration']['med'])
"
# Should print ~2643
```

If you find a number that doesn't match, open an issue — we'd rather fix it than defend it.

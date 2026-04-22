# Data Generator Scripts

Bulk-loads realistic WooCommerce data for stress-testing database-bound queries.

**Use with care** — these scripts bypass WooCommerce's APIs and write directly to the database via raw SQL INSERTs. They're fast (500K orders in ~5 minutes), but they require matching your exact WC schema version. Tested against **WooCommerce 10.6.2**.

## `generate-data.php` (single-site)

```bash
php generate-data.php <site_path> <scenario>
```

Scenarios:

| Scenario | What it generates |
|----------|-------------------|
| `base` | 100K users + 2M usermeta + 200 products + 500K HPOS orders + ~25M order item meta |
| `coupons-low` | 50 coupons × 100 `_used_by` entries (5K postmeta rows) |
| `coupons-high` | 10,000 coupons × 50 `_used_by` entries (500K postmeta rows) |

### Usage

```bash
# Upload to server
scp generate-data.php root@server:/root/

# On the server
ssh root@server
php -d memory_limit=1G /root/generate-data.php /var/www/classic base
php -d memory_limit=1G /root/generate-data.php /var/www/classic coupons-high
```

### What it creates

**Users (shared if multisite):**
- `wp_users` rows with `cust{N}@perftest.local` emails
- `wp_usermeta` with 20 keys per user: billing/shipping address, capabilities, WC customer flags

**Products:**
- 200 simple products with SKU `PERF-000001` through `PERF-000200`
- `wp_postmeta` for price, SKU, stock status
- `wc_product_meta_lookup` entries

**HPOS Orders (500K):**
- `wp_posts` placeholder rows with `post_type = 'shop_order_placehold'` (required for HPOS)
- `wp_wc_orders` with matching IDs
- `wp_wc_order_operational_data` with order keys and timestamps
- `wp_woocommerce_order_items` — 1 to 3 items per order
- `wp_woocommerce_order_itemmeta` — 7 meta rows per item (`_qty`, `_product_id`, `_line_total`, etc.)
- `wp_wc_orders_meta` — 2 rows per order (billing email, order key)

**Coupons:**
- `wp_posts` with `post_type = 'shop_coupon'`, titles `PERFCPN00001`–`PERFCPN10000`
- `wp_postmeta` with `_used_by` entries (the expensive-to-query pattern)

### Memory & time

With 4GB MariaDB buffer pool and PHP `memory_limit=1G`:

- 100K users + usermeta: ~3 minutes
- 500K orders: ~5 minutes
- 10K coupons + 500K used_by: ~90 seconds

## `generate-data-multisite.php`

Same scenarios, but writes to the correct per-subsite tables (`wp_2_wc_orders`, `wp_3_wc_orders`, …).

```bash
php generate-data-multisite.php <site_path> <host>
```

- `site_path` — the multisite install root (e.g. `/var/www/classic-ms`)
- `host` — the network's main domain (e.g. `classic-ms.example.com`) — required so WordPress's multisite bootstrap can load correctly

### Usage

```bash
php -d memory_limit=1G /root/generate-data-multisite.php \
  /var/www/classic-ms \
  classic-ms.example.com
```

### What it creates

- Users + usermeta (shared network-wide, 100K users + 1.8M usermeta)
- Per-subsite: 60K orders × 8 subsites = 480K total orders
- Products created automatically per subsite during site setup (not by this script)

## Cleanup

There's no "undo" script. To reset an instance, drop and recreate the database:

```bash
mysql -u root <<SQL
DROP DATABASE wc_classic;
CREATE DATABASE wc_classic;
GRANT ALL ON wc_classic.* TO 'wc_classic'@'localhost';
SQL

# Then re-run the WP-CLI setup from docs/setup-hetzner.md
```

## Known quirks

- **HPOS `wp_wc_orders.id` has no auto-increment.** Orders must have IDs that match a pre-existing `wp_posts` placeholder row. The script creates placeholders first, then uses the same IDs for `wc_orders` inserts.
- **`wp_users.user_level` was removed in WP 6.9.** Older versions of this script had that column in the INSERT and would fail.
- **`wp_wc_orders` and `wp_wc_order_operational_data` are separate tables in WC 10.6+.** Earlier WC versions may have combined them.
- **FS_METHOD = 'direct'** must be set in `wp-config.php` or WC's logger tries FTP and crashes.

## After loading data

Always flush caches before re-running benchmarks:

```bash
ssh root@server "
for SITE in classic storeapi; do
  cd /var/www/\$SITE && wp cache flush --allow-root
done
redis-cli FLUSHDB
killall -9 lsphp
"
```

# Hetzner Setup Guide

How to provision the server and install the exact stack used in these benchmarks. Any dedicated CPU VPS will work — Hetzner CCX33 is what we used.

**Stack:** Ubuntu 24.04, OpenLiteSpeed, LSPHP 8.3, MariaDB, Redis 7, WooCommerce 10.6+.

Throughout this guide, replace:

- `<SERVER_IP>` with your server's public IP
- `<CLASSIC_DOMAIN>` and `<STOREAPI_DOMAIN>` with the two domains you'll point at the server (e.g. `classic.example.com` and `storeapi.example.com`)
- `<DB_PASS_CLASSIC>`, `<DB_PASS_STOREAPI>`, `<WP_ADMIN_PASS>` with strong, unique passwords

---

## 1. Provision Server

- **Type:** dedicated CPU (not shared). Hetzner CCX33 = 8 dedicated AMD vCPU / 32 GB RAM / 240 GB NVMe, ~€50/mo with hourly billing.
- **OS:** Ubuntu 24.04.
- **Location:** any region geographically close to your k6 runner.

```bash
ssh root@<SERVER_IP>
apt update && apt upgrade -y

# Short hostname — long ones can break certbot IDNA encoding.
hostnamectl set-hostname wc-benchmark
```

---

## 2. Install OpenLiteSpeed + PHP + MariaDB + Redis

### OpenLiteSpeed + LSPHP

```bash
wget -O - https://repo.litespeed.sh | bash
apt update
apt install -y openlitespeed \
  lsphp83 lsphp83-common lsphp83-mysql lsphp83-opcache \
  lsphp83-curl lsphp83-imagick lsphp83-intl lsphp83-redis lsphp83-memcached

/usr/local/lsws/admin/misc/admpass.sh   # sets OLS admin password

systemctl enable lsws
systemctl start lsws
```

### Configure LSPHP 8.3 as External Processor

Edit `/usr/local/lsws/conf/httpd_config.conf` and add this block before any existing `extProcessor`:

```
extProcessor lsphp83{
    type                            lsapi
    address                         uds://tmp/lshttpd/lsphp83.sock
    maxConns                        60
    env                             PHP_LSAPI_CHILDREN=60
    env                             LSAPI_AVOID_FORK=200M
    initTimeout                     60
    retryTimeout                    0
    persistConn                     1
    pcKeepAliveTimeout
    respBuffer                      0
    autoStart                       2
    path                            lsphp83/bin/lsphp
    backlog                         100
    instances                       1
    priority                        0
    memSoftLimit                    0
    memHardLimit                    0
    procSoftLimit                   1400
    procHardLimit                   1500
}
```

Notes:

- `autoStart` must be `2` (detached) — mode `1` fails silently for secondary PHP versions.
- `maxConns` and `PHP_LSAPI_CHILDREN` scale with vCPU: **60 for 8 vCPU**, 30–40 for 4 vCPU, 10–20 for 2 vCPU.

### Configure php.ini

Append to `/usr/local/lsws/lsphp83/etc/php/8.3/litespeed/php.ini`:

```ini
[opcache]
opcache.enable=1
opcache.memory_consumption=256
opcache.interned_strings_buffer=32
opcache.max_accelerated_files=20000
opcache.revalidate_freq=60
opcache.validate_timestamps=1
opcache.save_comments=1
opcache.fast_shutdown=1

[PHP]
memory_limit = 256M
max_execution_time = 300
upload_max_filesize = 64M
post_max_size = 64M
```

### MariaDB

```bash
apt install -y mariadb-server
systemctl enable mariadb
mysql_secure_installation
```

Tuning — write `/etc/mysql/mariadb.conf.d/99-perf-test.cnf`:

```ini
[mysqld]
innodb_buffer_pool_size = 4G
innodb_log_file_size = 512M
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT
max_connections = 400
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1
query_cache_type = 0
query_cache_size = 0
```

Scale `innodb_buffer_pool_size` to ~25% of RAM (4G for 32GB).

```bash
systemctl restart mariadb
```

### Redis

```bash
apt install -y redis-server
systemctl enable redis-server
redis-cli ping   # → PONG
```

### WP-CLI

```bash
curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
chmod +x wp-cli.phar
mv wp-cli.phar /usr/local/bin/wp
```

---

## 3. DNS

Create two A records pointing at `<SERVER_IP>`:

| Type | Name | Value |
|------|------|-------|
| A | `<CLASSIC_DOMAIN>` | `<SERVER_IP>` |
| A | `<STOREAPI_DOMAIN>` | `<SERVER_IP>` |

If using Cloudflare: keep these records **DNS only** (grey cloud). The orange-cloud proxy invalidates benchmarks because it caches responses and changes TLS/HTTP characteristics.

---

## 4. Create Databases

```bash
mariadb -u root -p <<SQL
CREATE DATABASE wc_classic;
CREATE DATABASE wc_storeapi;
CREATE USER 'wc_classic'@'localhost'  IDENTIFIED BY '<DB_PASS_CLASSIC>';
CREATE USER 'wc_storeapi'@'localhost' IDENTIFIED BY '<DB_PASS_STOREAPI>';
GRANT ALL PRIVILEGES ON wc_classic.*  TO 'wc_classic'@'localhost';
GRANT ALL PRIVILEGES ON wc_storeapi.* TO 'wc_storeapi'@'localhost';
FLUSH PRIVILEGES;
SQL
```

---

## 5. Install Both WordPress Instances

### Classic instance

```bash
mkdir -p /var/www/classic && cd /var/www/classic
wp core download --allow-root
wp config create --dbname=wc_classic --dbuser=wc_classic \
  --dbpass='<DB_PASS_CLASSIC>' --dbhost=localhost --allow-root
wp core install --url="https://<CLASSIC_DOMAIN>" \
  --title="Classic Checkout" --admin_user=admin \
  --admin_password='<WP_ADMIN_PASS>' --admin_email=admin@example.com --allow-root

wp config set WP_DEBUG     false --raw --allow-root
wp config set WP_DEBUG_LOG false --raw --allow-root
wp config set FS_METHOD    direct --allow-root
```

### Store API instance

```bash
mkdir -p /var/www/storeapi && cd /var/www/storeapi
wp core download --allow-root
wp config create --dbname=wc_storeapi --dbuser=wc_storeapi \
  --dbpass='<DB_PASS_STOREAPI>' --dbhost=localhost --allow-root
wp core install --url="https://<STOREAPI_DOMAIN>" \
  --title="Store API Checkout" --admin_user=admin \
  --admin_password='<WP_ADMIN_PASS>' --admin_email=admin@example.com --allow-root

wp config set WP_DEBUG     false --raw --allow-root
wp config set WP_DEBUG_LOG false --raw --allow-root
wp config set FS_METHOD    direct --allow-root
```

### Install WooCommerce + theme + configure both

```bash
for SITE in classic storeapi; do
  cd /var/www/$SITE

  wp plugin install woocommerce --activate --allow-root
  wp theme install generatepress --activate --allow-root

  # Store settings.
  wp option update woocommerce_store_address "123 Test Street" --allow-root
  wp option update woocommerce_store_city "Berlin" --allow-root
  wp option update woocommerce_default_country "DE" --allow-root
  wp option update woocommerce_store_postcode "10115" --allow-root
  wp option update woocommerce_currency "EUR" --allow-root
  wp option update woocommerce_onboarding_profile '{"completed":true}' --format=json --allow-root

  # COD payment.
  wp option update woocommerce_cod_settings \
    '{"enabled":"yes","title":"Cash on delivery","description":"COD"}' \
    --format=json --allow-root

  # Flat rate shipping.
  wp wc shipping_zone create --name="Everywhere" --order=0 --user=1 --allow-root
  wp wc shipping_zone_method create 1 --method_id=flat_rate --user=1 --allow-root

  # Test coupon.
  wp wc shop_coupon create --code="TEST10" --amount=10 \
    --discount_type=fixed_cart --user=1 --allow-root

  wp rewrite structure '/%postname%/' --allow-root

  # WC performance features — all required for a fair comparison.
  wp option update woocommerce_custom_orders_table_enabled          yes --allow-root
  wp option update woocommerce_custom_orders_table_data_sync_enabled no  --allow-root
  wp option update woocommerce_hpos_datastore_caching_enabled       yes --allow-root
  wp option update woocommerce_hpos_fts_index_enabled               yes --allow-root
  wp option update woocommerce_feature_rest_api_caching_enabled     yes --allow-root
  wp option update woocommerce_feature_product_instance_caching_enabled yes --allow-root
  wp option update woocommerce_feature_destroy-empty-sessions_enabled yes --allow-root
  wp option update woocommerce_feature_order_attribution_enabled    no  --allow-root
  wp option update woocommerce_feature_remote_logging_enabled       no  --allow-root
  wp option update woocommerce_coming_soon                          no  --allow-root

  echo "$SITE configured"
done

# Store API only: Interactivity API mini cart.
cd /var/www/storeapi
wp option update woocommerce_feature_mini_cart_interactivity_enabled yes --allow-root
```

### Set page content — the architectural difference

```bash
# Classic: force shortcode pages.
cd /var/www/classic
CART_ID=$(wp option get woocommerce_cart_page_id --allow-root)
CHECKOUT_ID=$(wp option get woocommerce_checkout_page_id --allow-root)
wp post update $CART_ID     --post_content='[woocommerce_cart]'     --allow-root
wp post update $CHECKOUT_ID --post_content='[woocommerce_checkout]' --allow-root

# Store API: verify blocks are in place (WC 10.x default).
cd /var/www/storeapi
CART_ID=$(wp option get woocommerce_cart_page_id --allow-root)
wp post get $CART_ID --field=post_content --allow-root | head -1
# Should print: <!-- wp:woocommerce/cart -->
```

### Disable stock + import products

```bash
cd /var/www/classic
wp plugin install wordpress-importer --activate --allow-root
wp import wp-content/plugins/woocommerce/sample-data/sample_products.xml --authors=create --allow-root

for i in $(seq 1 25); do
  wp wc product create --name="Test Product $i" --type=simple \
    --regular_price="$(( (RANDOM % 50) + 5 )).99" --status=publish \
    --manage_stock=false --user=1 --allow-root 2>/dev/null
done

# Mirror products on Store API instance.
wp export --post_type=product --dir=/tmp/ --allow-root
EXPORT_FILE=$(ls -t /tmp/*.xml | head -1)
cd /var/www/storeapi
wp plugin install wordpress-importer --activate --allow-root
wp import "$EXPORT_FILE" --authors=create --allow-root

# Disable stock management on all products so 500 VU tests don't hit "out of stock".
for SITE in classic storeapi; do
  cd /var/www/$SITE
  for PID in $(wp wc product list --user=1 --allow-root --format=ids); do
    wp wc product update $PID --manage_stock=false --user=1 --allow-root 2>/dev/null
  done
  wp plugin deactivate wordpress-importer --allow-root
done
```

---

## 6. Redis Object Caching

Separate Redis DB indices per instance so they don't share cache keys:

```bash
for SITE in classic storeapi; do
  cd /var/www/$SITE
  wp plugin install redis-cache --activate --allow-root
done

cd /var/www/classic
sed -i "/\/\* That's all, stop editing/i\\
define( 'WP_REDIS_DATABASE', 0 );\\
define( 'WP_REDIS_PREFIX', 'classic_' );" wp-config.php

cd /var/www/storeapi
sed -i "/\/\* That's all, stop editing/i\\
define( 'WP_REDIS_DATABASE', 1 );\\
define( 'WP_REDIS_PREFIX', 'storeapi_' );" wp-config.php

for SITE in classic storeapi; do
  cd /var/www/$SITE && wp redis enable --allow-root
done
```

---

## 7. Benchmarking Mu-Plugins

These helpers let k6 acquire nonces once per VU instead of refreshing them inside the measurement loop. They're test-only — never deploy to production.

### Classic — `/var/www/classic/wp-content/mu-plugins/k6-nonce-helper.php`

```php
<?php
add_action( 'init', function () {
	if ( ! isset( $_GET['k6_get_nonce'] ) ) {
		return;
	}
	$type   = sanitize_text_field( $_GET['k6_get_nonce'] );
	$nonces = array();
	switch ( $type ) {
		case 'all':
		case 'checkout':
			$nonces['checkout_nonce'] = wp_create_nonce( 'woocommerce-process_checkout' );
			if ( 'checkout' === $type ) {
				break;
			}
		case 'coupon':
			$nonces['apply_coupon_nonce']  = wp_create_nonce( 'apply-coupon' );
			$nonces['remove_coupon_nonce'] = wp_create_nonce( 'remove-coupon' );
			break;
	}
	header( 'Content-Type: application/json' );
	echo json_encode( $nonces );
	exit;
} );
```

### Store API — `/var/www/storeapi/wp-content/mu-plugins/k6-nonce-helper.php`

```php
<?php
add_action( 'rest_api_init', function () {
	register_rest_route( 'k6-helper/v1', '/nonce', array(
		'methods'             => 'GET',
		'callback'            => function () {
			return array( 'nonce' => wp_create_nonce( 'wc_store_api' ) );
		},
		'permission_callback' => '__return_true',
	) );
} );
```

### Store API — `/var/www/storeapi/wp-content/mu-plugins/k6-store-api-optimizations.php`

```php
<?php
// Disable nonce check (testing only — saves ~5 ms per request).
add_filter( 'woocommerce_store_api_disable_nonce_check', '__return_true' );

// Disable cross-sells computation.
add_filter( 'woocommerce_cart_crosssell_ids', '__return_empty_array' );

// Preload Store API cart data in the page HTML.
add_filter( 'woocommerce_blocks_core_store_api_preload_paths', function ( $paths ) {
	$paths[] = '/wc/store/v1/cart/';
	return $paths;
} );
```

---

## 8. OLS Virtual Hosts + SSL

- Two vhosts (`classic`, `storeapi`) using `lsapi:lsphp83`.
- No `context / {}` block in the vhost config — it breaks `.htaccess` rewrites.
- SSL via Let's Encrypt certbot with `--webroot`.
- Disable the OLS cache module: set `ls_enabled 0` in `httpd_config.conf`.
- Deactivate any LiteSpeed Cache plugin on both instances (we want to measure PHP, not the page cache).

### `.htaccess` (create manually on both)

```
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
```

### File permissions

```bash
for SITE in classic storeapi; do
  chown -R nobody:nogroup /var/www/$SITE
  find /var/www/$SITE -type d -exec chmod 755 {} \;
  find /var/www/$SITE -type f -exec chmod 644 {} \;
done
```

---

## 9. Run Benchmarks

From a machine **other than the server**, with k6 and Node.js installed:

```bash
git clone https://github.com/Jorgu5/woocommerce-performance-benchmarks
cd woocommerce-performance-benchmarks/k6

# Baseline (1 VU, 2 min each).
for SCENARIO in s1 s2 s4 s6; do
  for MODE in classic storeapi; do
    EXTRA=""
    [ "$MODE" = "storeapi" ] && EXTRA="-e SKIP_NONCE=1"
    CLASSIC_URL=https://<CLASSIC_DOMAIN> \
    STOREAPI_URL=https://<STOREAPI_DOMAIN> \
      ./bench.sh $MODE $SCENARIO baseline $EXTRA
  done
done

# Light (50 VU) — change PROFILE=light, same loop.
# Medium (200 VU), Heavy (500 VU) — see k6/README.md.
```

Frontend tests:

```bash
cd ../lighthouse
npm install
RUNS=5 \
CLASSIC_URL=https://<CLASSIC_DOMAIN> \
STOREAPI_URL=https://<STOREAPI_DOMAIN> \
  node audit-cached.mjs all
```

---

## WC Feature Flags — Checklist

| Flag | Value | Why |
|------|-------|-----|
| `woocommerce_custom_orders_table_enabled` | **yes** | HPOS — ~1.5× faster checkout |
| `woocommerce_hpos_datastore_caching_enabled` | **yes** | Cache order objects in Redis |
| `woocommerce_hpos_fts_index_enabled` | **yes** | Full-text search on orders |
| `woocommerce_feature_rest_api_caching_enabled` | **yes** | Cache REST responses |
| `woocommerce_feature_product_instance_caching_enabled` | **yes** | Cache product hydration |
| `woocommerce_feature_destroy-empty-sessions_enabled` | **yes** | Clean up empty sessions |
| `woocommerce_feature_order_attribution_enabled` | **no** | Removes tracking overhead |
| `woocommerce_feature_remote_logging_enabled` | **no** | Removes logging overhead |
| `woocommerce_feature_mini_cart_interactivity_enabled` | **yes** | 20KB mini cart (Store API only) |
| `woocommerce_coming_soon` | **no** | Disables coming-soon mode |
| `WP_DEBUG` | **false** | No debug overhead |
| `WP_DEBUG_LOG` | **false** | No log file writes |

---

## Quick Reference

| Item | Classic | Store API |
|------|---------|-----------|
| URL | `https://<CLASSIC_DOMAIN>` | `https://<STOREAPI_DOMAIN>` |
| Doc root | `/var/www/classic/` | `/var/www/storeapi/` |
| Database | `wc_classic` | `wc_storeapi` |
| Redis DB | 0 (prefix `classic_`) | 1 (prefix `storeapi_`) |
| Cart | `[woocommerce_cart]` shortcode | `wp:woocommerce/cart` block |
| Checkout | `[woocommerce_checkout]` shortcode | `wp:woocommerce/checkout` block |
| API | `/?wc-ajax=*` | `/wp-json/wc/store/v1/*` |

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| REST API returns HTML | Missing trailing slash on URL | Add `/` to all Store API endpoints |
| OPcache serves old files | `validate_timestamps=0` | `killall -9 lsphp && systemctl restart lsws` |
| Checkout "unable to process" | Nonce fetched before `add_to_cart` | Fetch nonce *after* adding items |
| "Out of stock" during stress | Stock depleted | Set `manage_stock=false` on all products |
| Coupon "already applied" errors | VU reuses session across iterations | Expected — design of `s4`/`s5` |
| CPU 100% under stress | Server undersized | Add vCPUs |

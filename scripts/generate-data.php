<?php
/**
 * Generate realistic store data for performance testing.
 *
 * Run with: php generate-data.php <site_path> <scenario>
 *
 * Scenarios:
 *   base         — 500K orders, 100K users, 200 products
 *   coupons-low  — 50 coupons, ~5K used_by entries
 *   coupons-high — 10K coupons, ~500K used_by entries
 */

if ( $argc < 3 ) {
	echo "Usage: php generate-data.php <site_path> <scenario>\n";
	exit( 1 );
}

$site_path = $argv[1];
$scenario  = $argv[2];

$_SERVER['HTTP_HOST'] = 'localhost';
define( 'ABSPATH', rtrim( $site_path, '/' ) . '/' );
require_once ABSPATH . 'wp-load.php';

global $wpdb;

echo "DB: {$wpdb->dbname} | Scenario: {$scenario}\n";

$wpdb->query( 'SET autocommit=0' );
$wpdb->query( 'SET unique_checks=0' );
$wpdb->query( 'SET foreign_key_checks=0' );

$batch = 1000;

// ═══════════════════════════════════════════════════════════════════
// BASE: users, products, orders
// ═══════════════════════════════════════════════════════════════════

if ( 'base' === $scenario ) {

	// ── Users ──────────────────────────────────────────────────
	$have  = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->users}" );
	$want  = 100000;
	$need  = $want - $have;

	if ( $need > 0 ) {
		echo "Users: generating {$need}...\n";
		$vals = array();
		for ( $i = 0; $i < $need; $i++ ) {
			$n     = $have + $i + 1;
			$vals[] = $wpdb->prepare(
				"(%s, %s, %s, %s, '', 0, NOW(), '', %s)",
				"cust{$n}",
				md5( "pass{$n}" ),
				"cust{$n}",
				"cust{$n}@perftest.local",
				"Customer {$n}"
			);
			if ( count( $vals ) >= $batch ) {
				$wpdb->query(
					"INSERT INTO {$wpdb->users} (user_login, user_pass, user_nicename, user_email, user_url, user_status, user_registered, user_activation_key, display_name) VALUES " . implode( ',', $vals )
				);
				$wpdb->query( 'COMMIT' );
				$vals = array();
				if ( $i % 10000 === 0 ) {
					echo "  {$i}/{$need}\n";
				}
			}
		}
		if ( ! empty( $vals ) ) {
			$wpdb->query(
				"INSERT INTO {$wpdb->users} (user_login, user_pass, user_nicename, user_email, user_url, user_status, user_registered, user_activation_key, display_name) VALUES " . implode( ',', $vals )
			);
			$wpdb->query( 'COMMIT' );
		}
		echo "  Users done.\n";

		// Usermeta (~20 keys per user).
		echo "Usermeta: generating...\n";
		$keys   = array(
			'billing_first_name', 'billing_last_name', 'billing_email',
			'billing_phone', 'billing_address_1', 'billing_city',
			'billing_state', 'billing_postcode', 'billing_country',
			'shipping_first_name', 'shipping_last_name', 'shipping_address_1',
			'shipping_city', 'shipping_state', 'shipping_postcode',
			'shipping_country', 'wp_capabilities', 'wp_user_level',
			'paying_customer', 'wc_last_active',
		);
		$cities  = array( 'Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart' );
		$streets = array( 'Hauptstr.', 'Berliner Str.', 'Friedrichstr.', 'Goethestr.' );

		$uids = $wpdb->get_col( "SELECT ID FROM {$wpdb->users} WHERE ID > 1" );
		$vals = array();
		$b    = 0;
		foreach ( $uids as $uid ) {
			$city   = $cities[ array_rand( $cities ) ];
			$street = $streets[ array_rand( $streets ) ] . ' ' . wp_rand( 1, 200 );
			$pc     = str_pad( (string) wp_rand( 10000, 99999 ), 5, '0' );
			foreach ( $keys as $k ) {
				switch ( $k ) {
					case 'billing_first_name':
					case 'shipping_first_name':
						$v = 'Customer';
						break;
					case 'billing_last_name':
					case 'shipping_last_name':
						$v = "Test{$uid}";
						break;
					case 'billing_email':
						$v = "cust{$uid}@perftest.local";
						break;
					case 'billing_phone':
						$v = '+49' . wp_rand( 1000000, 9999999 );
						break;
					case 'billing_address_1':
					case 'shipping_address_1':
						$v = $street;
						break;
					case 'billing_city':
					case 'shipping_city':
						$v = $city;
						break;
					case 'billing_postcode':
					case 'shipping_postcode':
						$v = $pc;
						break;
					case 'billing_country':
					case 'shipping_country':
						$v = 'DE';
						break;
					case 'billing_state':
					case 'shipping_state':
						$v = '';
						break;
					case 'wp_capabilities':
						$v = 'a:1:{s:8:"customer";b:1;}';
						break;
					case 'wp_user_level':
						$v = '0';
						break;
					case 'paying_customer':
						$v = '1';
						break;
					case 'wc_last_active':
						$v = (string) time();
						break;
					default:
						$v = '';
				}
				$vals[] = $wpdb->prepare( '(%d,%s,%s)', $uid, $k, $v );
			}
			if ( count( $vals ) >= $batch * 10 ) {
				$wpdb->query( "INSERT INTO {$wpdb->usermeta} (user_id,meta_key,meta_value) VALUES " . implode( ',', $vals ) );
				$wpdb->query( 'COMMIT' );
				$vals = array();
				$b++;
				if ( $b % 10 === 0 ) {
					echo "  Usermeta batch {$b}\n";
				}
			}
		}
		if ( ! empty( $vals ) ) {
			$wpdb->query( "INSERT INTO {$wpdb->usermeta} (user_id,meta_key,meta_value) VALUES " . implode( ',', $vals ) );
			$wpdb->query( 'COMMIT' );
		}
		echo "  Usermeta done.\n";
	} else {
		echo "Users: already at {$have}\n";
	}

	// ── Products ──────────────────────────────────────────────
	$have = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish'" );
	$want = 200;
	$need = $want - $have;

	if ( $need > 0 ) {
		echo "Products: generating {$need}...\n";
		for ( $i = 0; $i < $need; $i++ ) {
			$price = wp_rand( 5, 100 ) . '.99';
			$wpdb->insert(
				$wpdb->posts,
				array(
					'post_author'       => 1,
					'post_title'        => 'Perf Product ' . ( $have + $i + 1 ),
					'post_name'         => 'perf-product-' . ( $have + $i + 1 ),
					'post_status'       => 'publish',
					'post_type'         => 'product',
					'post_date'         => current_time( 'mysql' ),
					'post_date_gmt'     => current_time( 'mysql', 1 ),
					'post_modified'     => current_time( 'mysql' ),
					'post_modified_gmt' => current_time( 'mysql', 1 ),
				)
			);
			$pid = $wpdb->insert_id;
			$sku = 'PERF-' . str_pad( (string) $pid, 6, '0', STR_PAD_LEFT );

			foreach ( array(
				'_price'           => $price,
				'_regular_price'   => $price,
				'_sku'             => $sku,
				'_stock_status'    => 'instock',
				'_manage_stock'    => 'no',
				'_virtual'         => 'no',
				'_downloadable'    => 'no',
				'_product_version' => '10.6.2',
			) as $k => $v ) {
				$wpdb->insert( $wpdb->postmeta, array( 'post_id' => $pid, 'meta_key' => $k, 'meta_value' => $v ) );
			}

			$wpdb->query(
				$wpdb->prepare(
					"INSERT IGNORE INTO {$wpdb->prefix}wc_product_meta_lookup (product_id,sku,min_price,max_price,stock_status) VALUES (%d,%s,%f,%f,%s)",
					$pid, $sku, $price, $price, 'instock'
				)
			);
		}
		$wpdb->query( 'COMMIT' );
		echo "  Products done.\n";
	}

	// ── Orders (HPOS) ─────────────────────────────────────────
	$have = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->prefix}wc_orders" );
	$want = 500000;
	$need = $want - $have;

	if ( $need > 0 ) {
		echo "Orders: generating {$need} (HPOS)...\n";
		$statuses    = array( 'wc-completed', 'wc-completed', 'wc-completed', 'wc-processing', 'wc-on-hold' );
		$product_ids = $wpdb->get_col( "SELECT ID FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish' LIMIT 50" );
		if ( empty( $product_ids ) ) {
			$product_ids = array( 15 );
		}
		$user_max = (int) $wpdb->get_var( "SELECT MAX(ID) FROM {$wpdb->users}" );
		$item_id  = (int) $wpdb->get_var( "SELECT COALESCE(MAX(order_item_id),0) FROM {$wpdb->prefix}woocommerce_order_items" ) + 1;

		// HPOS orders share IDs with wp_posts (shop_order_placehold).
		// We must create placeholder posts first, then use those IDs.
		$next_oid = (int) $wpdb->get_var( "SELECT COALESCE(MAX(ID),0) FROM {$wpdb->posts}" ) + 1;

		// Pre-create all placeholder posts in batches.
		echo "  Creating {$need} placeholder posts...\n";
		$p_vals = array();
		for ( $p = 0; $p < $need; $p++ ) {
			$pid = $next_oid + $p;
			$p_vals[] = "({$pid},1,'','shop_order_placehold','','draft','shop_order_placehold',NOW(),NOW(),NOW(),NOW(),'','','',0,'','',0,0,'','')";
			if ( count( $p_vals ) >= $batch ) {
				$wpdb->query( "INSERT INTO {$wpdb->posts} (ID,post_author,post_content,post_title,post_excerpt,post_status,post_type,post_date,post_date_gmt,post_modified,post_modified_gmt,post_name,to_ping,pinged,post_parent,guid,post_mime_type,comment_count,menu_order,post_password,post_content_filtered) VALUES " . implode( ',', $p_vals ) );
				$wpdb->query( 'COMMIT' );
				$p_vals = array();
				if ( $p % 100000 === 0 ) {
					echo "    Placeholders: {$p}/{$need}\n";
				}
			}
		}
		if ( ! empty( $p_vals ) ) {
			$wpdb->query( "INSERT INTO {$wpdb->posts} (ID,post_author,post_content,post_title,post_excerpt,post_status,post_type,post_date,post_date_gmt,post_modified,post_modified_gmt,post_name,to_ping,pinged,post_parent,guid,post_mime_type,comment_count,menu_order,post_password,post_content_filtered) VALUES " . implode( ',', $p_vals ) );
			$wpdb->query( 'COMMIT' );
		}
		echo "  Placeholders done.\n";

		$o_vals  = array();
		$op_vals = array();
		$i_vals  = array();
		$im_vals = array();
		$om_vals = array();

		for ( $i = 0; $i < $need; $i++ ) {
			$st   = $statuses[ array_rand( $statuses ) ];
			$uid  = wp_rand( 2, $user_max );
			$tot  = wp_rand( 10, 200 ) . '.' . str_pad( (string) wp_rand( 0, 99 ), 2, '0' );
			$days = wp_rand( 0, 730 );
			$dt   = gmdate( 'Y-m-d H:i:s', time() - $days * 86400 );
			$oid  = $next_oid + $i;
			$email = "cust{$uid}@perftest.local";
			$okey = 'wc_order_' . wp_generate_password( 12, false );

			// wp_wc_orders — main order table (explicit ID from placeholder post).
			$o_vals[] = $wpdb->prepare(
				'(%d,%d,%s,%s,%s,%s,%s,%s,%s,%s)',
				$oid, $uid, $st, 'shop_order', 'EUR', $tot, 0, $dt, $dt, 'cod'
			);

			// wp_wc_order_operational_data — dates, order_key, etc.
			$op_vals[] = $wpdb->prepare(
				'(%d,%s,%s,0,0,0,%s,0,%s,0,%s,%s,0,0,0,0,0)',
				$oid, 'checkout', '10.6.2', $okey, $okey, $dt, $dt
			);

			$nitems = wp_rand( 1, 3 );
			for ( $j = 0; $j < $nitems; $j++ ) {
				$pid = $product_ids[ array_rand( $product_ids ) ];
				$qty = wp_rand( 1, 3 );
				$lt  = wp_rand( 5, 80 ) . '.99';

				$i_vals[]  = "({$item_id},'line_item',{$oid},'Product')";
				$im_vals[] = "({$item_id},'_qty','{$qty}')";
				$im_vals[] = "({$item_id},'_product_id','{$pid}')";
				$im_vals[] = "({$item_id},'_line_total','{$lt}')";
				$im_vals[] = "({$item_id},'_line_subtotal','{$lt}')";
				$im_vals[] = "({$item_id},'_line_tax','0')";
				$im_vals[] = "({$item_id},'_line_subtotal_tax','0')";
				$im_vals[] = "({$item_id},'_line_tax_data','a:2:{s:5:\"total\";a:0:{}s:8:\"subtotal\";a:0:{}}')";
				$item_id++;
			}

			$om_vals[] = $wpdb->prepare( '(%d,%s,%s)', $oid, '_billing_email', $email );

			if ( count( $o_vals ) >= $batch ) {
				$wpdb->query( "INSERT INTO {$wpdb->prefix}wc_orders (id,customer_id,status,type,currency,total_amount,tax_amount,date_created_gmt,date_updated_gmt,payment_method) VALUES " . implode( ',', $o_vals ) );
				$wpdb->query( "INSERT INTO {$wpdb->prefix}wc_order_operational_data (order_id,created_via,woocommerce_version,prices_include_tax,coupon_usages_are_counted,download_permission_granted,cart_hash,new_order_email_sent,order_key,order_stock_reduced,date_paid_gmt,date_completed_gmt,shipping_tax_amount,shipping_total_amount,discount_tax_amount,discount_total_amount,recorded_sales) VALUES " . implode( ',', $op_vals ) );
				if ( ! empty( $i_vals ) ) {
					$wpdb->query( "INSERT INTO {$wpdb->prefix}woocommerce_order_items (order_item_id,order_item_type,order_id,order_item_name) VALUES " . implode( ',', $i_vals ) );
				}
				if ( ! empty( $im_vals ) ) {
					$wpdb->query( "INSERT INTO {$wpdb->prefix}woocommerce_order_itemmeta (order_item_id,meta_key,meta_value) VALUES " . implode( ',', $im_vals ) );
				}
				if ( ! empty( $om_vals ) ) {
					$wpdb->query( "INSERT INTO {$wpdb->prefix}wc_orders_meta (order_id,meta_key,meta_value) VALUES " . implode( ',', $om_vals ) );
				}
				$wpdb->query( 'COMMIT' );
				$o_vals = $op_vals = $i_vals = $im_vals = $om_vals = array();
				if ( $i % 50000 === 0 ) {
					echo "  Orders: {$i}/{$need}\n";
				}
			}
		}
		if ( ! empty( $o_vals ) ) {
			$wpdb->query( "INSERT INTO {$wpdb->prefix}wc_orders (id,customer_id,status,type,currency,total_amount,tax_amount,date_created_gmt,date_updated_gmt,payment_method) VALUES " . implode( ',', $o_vals ) );
			$wpdb->query( "INSERT INTO {$wpdb->prefix}wc_order_operational_data (order_id,created_via,woocommerce_version,prices_include_tax,coupon_usages_are_counted,download_permission_granted,cart_hash,new_order_email_sent,order_key,order_stock_reduced,date_paid_gmt,date_completed_gmt,shipping_tax_amount,shipping_total_amount,discount_tax_amount,discount_total_amount,recorded_sales) VALUES " . implode( ',', $op_vals ) );
			if ( ! empty( $i_vals ) ) {
				$wpdb->query( "INSERT INTO {$wpdb->prefix}woocommerce_order_items (order_item_id,order_item_type,order_id,order_item_name) VALUES " . implode( ',', $i_vals ) );
			}
			if ( ! empty( $im_vals ) ) {
				$wpdb->query( "INSERT INTO {$wpdb->prefix}woocommerce_order_itemmeta (order_item_id,meta_key,meta_value) VALUES " . implode( ',', $im_vals ) );
			}
			if ( ! empty( $om_vals ) ) {
				$wpdb->query( "INSERT INTO {$wpdb->prefix}wc_orders_meta (order_id,meta_key,meta_value) VALUES " . implode( ',', $om_vals ) );
			}
			$wpdb->query( 'COMMIT' );
		}
		echo "  Orders done.\n";
	} else {
		echo "Orders: already at {$have}\n";
	}
}

// ═══════════════════════════════════════════════════════════════════
// COUPONS
// ═══════════════════════════════════════════════════════════════════

if ( 'coupons-low' === $scenario || 'coupons-high' === $scenario ) {
	$num      = 'coupons-low' === $scenario ? 50 : 10000;
	$used_per = 'coupons-low' === $scenario ? 100 : 50;
	$total    = $num * $used_per;

	echo "Coupons: {$num} with {$used_per} used_by each ({$total} postmeta rows)...\n";

	// Clear previous perf coupons.
	$wpdb->query( "DELETE p, pm FROM {$wpdb->posts} p LEFT JOIN {$wpdb->postmeta} pm ON p.ID = pm.post_id WHERE p.post_type='shop_coupon' AND p.post_title LIKE 'PERFCPN%'" );
	$wpdb->query( 'COMMIT' );

	$mvals = array();
	for ( $c = 1; $c <= $num; $c++ ) {
		$code = 'PERFCPN' . str_pad( (string) $c, 5, '0', STR_PAD_LEFT );
		$disc = wp_rand( 5, 25 );

		$wpdb->insert(
			$wpdb->posts,
			array(
				'post_author'       => 1,
				'post_title'        => $code,
				'post_name'         => strtolower( $code ),
				'post_status'       => 'publish',
				'post_type'         => 'shop_coupon',
				'post_date'         => current_time( 'mysql' ),
				'post_date_gmt'     => current_time( 'mysql', 1 ),
				'post_modified'     => current_time( 'mysql' ),
				'post_modified_gmt' => current_time( 'mysql', 1 ),
			)
		);
		$cid = $wpdb->insert_id;

		// Coupon settings meta.
		foreach ( array(
			'discount_type'       => 'fixed_cart',
			'coupon_amount'       => (string) $disc,
			'usage_count'         => (string) $used_per,
			'usage_limit'         => '0',
			'usage_limit_per_user' => '1',
			'date_expires'        => '',
		) as $k => $v ) {
			$mvals[] = $wpdb->prepare( '(%d,%s,%s)', $cid, $k, $v );
		}

		// used_by entries — the expensive part for coupon validation.
		for ( $u = 0; $u < $used_per; $u++ ) {
			$email  = 'cust' . wp_rand( 1, 100000 ) . '@perftest.local';
			$mvals[] = $wpdb->prepare( '(%d,%s,%s)', $cid, '_used_by', $email );
		}

		if ( count( $mvals ) >= $batch * 5 ) {
			$wpdb->query( "INSERT INTO {$wpdb->postmeta} (post_id,meta_key,meta_value) VALUES " . implode( ',', $mvals ) );
			$wpdb->query( 'COMMIT' );
			$mvals = array();
			if ( $c % 1000 === 0 ) {
				echo "  Coupons: {$c}/{$num}\n";
			}
		}
	}
	if ( ! empty( $mvals ) ) {
		$wpdb->query( "INSERT INTO {$wpdb->postmeta} (post_id,meta_key,meta_value) VALUES " . implode( ',', $mvals ) );
		$wpdb->query( 'COMMIT' );
	}
	echo "  Coupons done.\n";
}

// Restore.
$wpdb->query( 'SET autocommit=1' );
$wpdb->query( 'SET unique_checks=1' );
$wpdb->query( 'SET foreign_key_checks=1' );

// Report.
echo "\nFinal counts:\n";
foreach ( array(
	'wc_orders',
	'wc_orders_meta',
	'woocommerce_order_items',
	'woocommerce_order_itemmeta',
	'users',
	'usermeta',
	'posts',
	'postmeta',
) as $t ) {
	$full = $wpdb->prefix . $t;
	$cnt  = $wpdb->get_var( "SELECT COUNT(*) FROM {$full}" );
	echo "  {$full}: " . number_format( (float) $cnt ) . "\n";
}
echo "\nDone!\n";

<?php
/**
 * Generate realistic data for multisite performance testing.
 *
 * Run with: php generate-data-multisite.php <site_path>
 *
 * Creates:
 *   - 100K users + 2M usermeta (shared network-wide)
 *   - 60K orders per subsite (8 subsites = 480K total)
 *   - ~120K order items per subsite
 *   - ~840K order item meta per subsite
 */

if ( $argc < 2 ) {
	echo "Usage: php generate-data-multisite.php <site_path>\n";
	exit( 1 );
}

$site_path = $argv[1];
$host      = $argv[2] ?? 'localhost';
$_SERVER['HTTP_HOST']   = $host;
$_SERVER['SERVER_NAME'] = $host;
define( 'ABSPATH', rtrim( $site_path, '/' ) . '/' );
require_once ABSPATH . 'wp-load.php';

global $wpdb;
echo "DB: {$wpdb->dbname}\n";

$wpdb->query( 'SET autocommit=0' );
$wpdb->query( 'SET unique_checks=0' );
$wpdb->query( 'SET foreign_key_checks=0' );

$batch = 1000;

// ── Users (shared, network-wide) ──────────────────────────────────
$have = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->users}" );
$want = 100000;
$need = $want - $have;

if ( $need > 0 ) {
	echo "Users: generating {$need}...\n";
	$vals = array();
	for ( $i = 0; $i < $need; $i++ ) {
		$n     = $have + $i + 1;
		$vals[] = $wpdb->prepare(
			"(%s, %s, %s, %s, '', 0, NOW(), '', %s)",
			"cust{$n}", md5( "pass{$n}" ), "cust{$n}",
			"cust{$n}@perftest.local", "Customer {$n}"
		);
		if ( count( $vals ) >= $batch ) {
			$wpdb->query(
				"INSERT INTO {$wpdb->users} (user_login,user_pass,user_nicename,user_email,user_url,user_status,user_registered,user_activation_key,display_name) VALUES " . implode( ',', $vals )
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
			"INSERT INTO {$wpdb->users} (user_login,user_pass,user_nicename,user_email,user_url,user_status,user_registered,user_activation_key,display_name) VALUES " . implode( ',', $vals )
		);
		$wpdb->query( 'COMMIT' );
	}

	// Usermeta
	echo "Usermeta...\n";
	$keys   = array(
		'billing_first_name', 'billing_last_name', 'billing_email',
		'billing_phone', 'billing_address_1', 'billing_city',
		'billing_postcode', 'billing_country',
		'shipping_first_name', 'shipping_last_name', 'shipping_address_1',
		'shipping_city', 'shipping_postcode', 'shipping_country',
		'wp_capabilities', 'wp_user_level', 'paying_customer', 'wc_last_active',
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
					$v = 'Customer'; break;
				case 'billing_last_name':
				case 'shipping_last_name':
					$v = "Test{$uid}"; break;
				case 'billing_email':
					$v = "cust{$uid}@perftest.local"; break;
				case 'billing_phone':
					$v = '+49' . wp_rand( 1000000, 9999999 ); break;
				case 'billing_address_1':
				case 'shipping_address_1':
					$v = $street; break;
				case 'billing_city':
				case 'shipping_city':
					$v = $city; break;
				case 'billing_postcode':
				case 'shipping_postcode':
					$v = $pc; break;
				case 'billing_country':
				case 'shipping_country':
					$v = 'DE'; break;
				case 'wp_capabilities':
					$v = 'a:1:{s:8:"customer";b:1;}'; break;
				case 'wp_user_level':
					$v = '0'; break;
				case 'paying_customer':
					$v = '1'; break;
				case 'wc_last_active':
					$v = (string) time(); break;
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
	echo "  Users + usermeta done.\n";
} else {
	echo "Users: already at {$have}\n";
}

// ── Orders per subsite ────────────────────────────────────────────
$sites = $wpdb->get_results( "SELECT blog_id FROM {$wpdb->blogs} WHERE blog_id > 1 ORDER BY blog_id" );
$target_orders_per_site = 60000;
$user_max = (int) $wpdb->get_var( "SELECT MAX(ID) FROM {$wpdb->users}" );

$statuses    = array( 'wc-completed', 'wc-completed', 'wc-completed', 'wc-processing', 'wc-on-hold' );

foreach ( $sites as $site ) {
	$bid = $site->blog_id;
	$prefix = $wpdb->get_blog_prefix( $bid );

	$have = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$prefix}wc_orders" );
	$need = $target_orders_per_site - $have;

	if ( $need <= 0 ) {
		echo "Site {$bid}: orders already at {$have}\n";
		continue;
	}

	echo "Site {$bid}: generating {$need} orders...\n";

	// Get product IDs for this subsite
	$product_ids = $wpdb->get_col( "SELECT ID FROM {$prefix}posts WHERE post_type='product' AND post_status='publish' LIMIT 20" );
	if ( empty( $product_ids ) ) {
		$product_ids = array( 10 );
	}

	// Next post ID for placeholders
	$next_pid = (int) $wpdb->get_var( "SELECT COALESCE(MAX(ID),0) FROM {$prefix}posts" ) + 1;
	$item_id  = (int) $wpdb->get_var( "SELECT COALESCE(MAX(order_item_id),0) FROM {$prefix}woocommerce_order_items" ) + 1;

	// Create placeholder posts
	$p_vals = array();
	for ( $p = 0; $p < $need; $p++ ) {
		$pid = $next_pid + $p;
		$p_vals[] = "({$pid},1,'','shop_order_placehold','','draft','shop_order_placehold',NOW(),NOW(),NOW(),NOW(),'','','',0,'','',0,0,'','')";
		if ( count( $p_vals ) >= $batch ) {
			$wpdb->query( "INSERT INTO {$prefix}posts (ID,post_author,post_content,post_title,post_excerpt,post_status,post_type,post_date,post_date_gmt,post_modified,post_modified_gmt,post_name,to_ping,pinged,post_parent,guid,post_mime_type,comment_count,menu_order,post_password,post_content_filtered) VALUES " . implode( ',', $p_vals ) );
			$wpdb->query( 'COMMIT' );
			$p_vals = array();
		}
	}
	if ( ! empty( $p_vals ) ) {
		$wpdb->query( "INSERT INTO {$prefix}posts (ID,post_author,post_content,post_title,post_excerpt,post_status,post_type,post_date,post_date_gmt,post_modified,post_modified_gmt,post_name,to_ping,pinged,post_parent,guid,post_mime_type,comment_count,menu_order,post_password,post_content_filtered) VALUES " . implode( ',', $p_vals ) );
		$wpdb->query( 'COMMIT' );
	}

	// Create orders + items
	$o_vals = $op_vals = $i_vals = $im_vals = $om_vals = array();

	for ( $i = 0; $i < $need; $i++ ) {
		$oid  = $next_pid + $i;
		$st   = $statuses[ array_rand( $statuses ) ];
		$uid  = wp_rand( 2, $user_max );
		$tot  = wp_rand( 10, 200 ) . '.' . str_pad( (string) wp_rand( 0, 99 ), 2, '0' );
		$days = wp_rand( 0, 730 );
		$dt   = gmdate( 'Y-m-d H:i:s', time() - $days * 86400 );
		$okey = 'wc_order_' . wp_generate_password( 12, false );

		$o_vals[]  = $wpdb->prepare( '(%d,%d,%s,%s,%s,%s,%s,%s,%s,%s)', $oid, $uid, $st, 'shop_order', 'EUR', $tot, 0, $dt, $dt, 'cod' );
		$op_vals[] = $wpdb->prepare( '(%d,%s,%s,0,0,0,%s,0,%s,0,%s,%s,0,0,0,0,0)', $oid, 'checkout', '10.6.2', $okey, $okey, $dt, $dt );

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

		$om_vals[] = $wpdb->prepare( '(%d,%s,%s)', $oid, '_billing_email', "cust{$uid}@perftest.local" );

		if ( count( $o_vals ) >= $batch ) {
			$wpdb->query( "INSERT INTO {$prefix}wc_orders (id,customer_id,status,type,currency,total_amount,tax_amount,date_created_gmt,date_updated_gmt,payment_method) VALUES " . implode( ',', $o_vals ) );
			$wpdb->query( "INSERT INTO {$prefix}wc_order_operational_data (order_id,created_via,woocommerce_version,prices_include_tax,coupon_usages_are_counted,download_permission_granted,cart_hash,new_order_email_sent,order_key,order_stock_reduced,date_paid_gmt,date_completed_gmt,shipping_tax_amount,shipping_total_amount,discount_tax_amount,discount_total_amount,recorded_sales) VALUES " . implode( ',', $op_vals ) );
			if ( ! empty( $i_vals ) ) {
				$wpdb->query( "INSERT INTO {$prefix}woocommerce_order_items (order_item_id,order_item_type,order_id,order_item_name) VALUES " . implode( ',', $i_vals ) );
			}
			if ( ! empty( $im_vals ) ) {
				$wpdb->query( "INSERT INTO {$prefix}woocommerce_order_itemmeta (order_item_id,meta_key,meta_value) VALUES " . implode( ',', $im_vals ) );
			}
			if ( ! empty( $om_vals ) ) {
				$wpdb->query( "INSERT INTO {$prefix}wc_orders_meta (order_id,meta_key,meta_value) VALUES " . implode( ',', $om_vals ) );
			}
			$wpdb->query( 'COMMIT' );
			$o_vals = $op_vals = $i_vals = $im_vals = $om_vals = array();
			if ( $i % 10000 === 0 ) {
				echo "  Site {$bid}: {$i}/{$need}\n";
			}
		}
	}
	// Flush
	if ( ! empty( $o_vals ) ) {
		$wpdb->query( "INSERT INTO {$prefix}wc_orders (id,customer_id,status,type,currency,total_amount,tax_amount,date_created_gmt,date_updated_gmt,payment_method) VALUES " . implode( ',', $o_vals ) );
		$wpdb->query( "INSERT INTO {$prefix}wc_order_operational_data (order_id,created_via,woocommerce_version,prices_include_tax,coupon_usages_are_counted,download_permission_granted,cart_hash,new_order_email_sent,order_key,order_stock_reduced,date_paid_gmt,date_completed_gmt,shipping_tax_amount,shipping_total_amount,discount_tax_amount,discount_total_amount,recorded_sales) VALUES " . implode( ',', $op_vals ) );
		if ( ! empty( $i_vals ) ) {
			$wpdb->query( "INSERT INTO {$prefix}woocommerce_order_items (order_item_id,order_item_type,order_id,order_item_name) VALUES " . implode( ',', $i_vals ) );
		}
		if ( ! empty( $im_vals ) ) {
			$wpdb->query( "INSERT INTO {$prefix}woocommerce_order_itemmeta (order_item_id,meta_key,meta_value) VALUES " . implode( ',', $im_vals ) );
		}
		if ( ! empty( $om_vals ) ) {
			$wpdb->query( "INSERT INTO {$prefix}wc_orders_meta (order_id,meta_key,meta_value) VALUES " . implode( ',', $om_vals ) );
		}
		$wpdb->query( 'COMMIT' );
	}
	echo "  Site {$bid}: done.\n";
}

$wpdb->query( 'SET autocommit=1' );
$wpdb->query( 'SET unique_checks=1' );
$wpdb->query( 'SET foreign_key_checks=1' );

echo "\nFinal counts:\n";
echo "  Users: " . number_format( (float) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->users}" ) ) . "\n";
echo "  Usermeta: " . number_format( (float) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->usermeta}" ) ) . "\n";
foreach ( $sites as $site ) {
	$prefix = $wpdb->get_blog_prefix( $site->blog_id );
	$orders = $wpdb->get_var( "SELECT COUNT(*) FROM {$prefix}wc_orders" );
	$items  = $wpdb->get_var( "SELECT COUNT(*) FROM {$prefix}woocommerce_order_items" );
	echo "  Site {$site->blog_id}: " . number_format( (float) $orders ) . " orders, " . number_format( (float) $items ) . " items\n";
}
echo "\nDone!\n";

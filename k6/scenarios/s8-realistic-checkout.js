/**
 * S8: Realistic Checkout Flow
 *
 * Simulates real customer behavior based on anonymized production data:
 * - Weighted product selection (one variant is ~45% of orders)
 * - Average 2.1 items per order
 * - 45% of orders use a coupon
 * - Billing addresses match real country distribution (IE 54%, NL 14%, etc.)
 * - Think time between actions
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s8-realistic-checkout.js
 *   k6 run -e MODE=storeapi -e SKIP_NONCE=1 scenarios/s8-realistic-checkout.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { getMode, getConfig, PRODUCTS, getProductId } from '../config.js';
import { pickProduct, pickItemCount, pickCoupon, pickAddress, thinkTime } from '../lib/realistic-flow.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

const journeyDuration = new Trend( 'journey_duration', true );
const journeySuccess = new Counter( 'journey_success' );
const journeyFail = new Counter( 'journey_fail' );
const itemsAdded = new Counter( 'items_added' );

export const options = {
	scenarios: {
		realistic: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
};

const mode = getMode();
const cfg = getConfig();

export default function () {
	const journeyStart = Date.now();
	const address = pickAddress();
	const itemCount = pickItemCount();
	const coupon = pickCoupon();

	if ( mode === 'classic' ) {
		classicJourney( itemCount, coupon, address );
	} else {
		storeapiJourney( itemCount, coupon, address );
	}

	const duration = Date.now() - journeyStart;
	journeyDuration.add( duration );
}

function classicJourney( itemCount, coupon, address ) {
	const { jar, nonces } = classic.initSession( cfg.baseUrl );

	// 1. Browse shop
	const shopRes = http.get( `${ cfg.baseUrl }/shop/`, {
		jar,
		tags: { name: 'classic-shop' },
	} );
	check( shopRes, { 'shop 200': ( r ) => r.status === 200 } );
	sleep( thinkTime( 'browsing' ) / 1000 );

	// 2. Add items to cart (avg 2.1)
	const addedProducts = [];
	for ( let i = 0; i < itemCount; i++ ) {
		const product = pickProduct( PRODUCTS );
		const productId = getProductId( product );

		const addPayload = { product_id: productId, quantity: 1 };

		// For variations, add via the variation ID directly
		if ( product.type === 'variation' ) {
			addPayload.product_id = product.parentId;
			addPayload.variation_id = productId;
		}

		const addRes = http.post(
			`${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
			addPayload,
			{ jar, tags: { name: 'classic-add-to-cart' } }
		);

		if ( addRes.status === 200 ) {
			itemsAdded.add( 1 );
			addedProducts.push( product );
		}

		if ( i < itemCount - 1 ) {
			sleep( thinkTime( 'adding' ) / 1000 );
		}
	}

	sleep( thinkTime( 'browsing' ) / 1000 );

	// 3. View cart
	http.get( `${ cfg.baseUrl }/cart/`, {
		jar,
		tags: { name: 'classic-cart' },
	} );
	classic.getCartFragments( cfg.baseUrl, jar );
	sleep( thinkTime( 'cart_review' ) / 1000 );

	// 4. Apply coupon (45% chance)
	if ( coupon ) {
		classic.applyCoupon( cfg.baseUrl, coupon, jar, nonces.apply_coupon_nonce );
		sleep( thinkTime( 'browsing' ) / 1000 );
	}

	// 5. Get checkout nonce (must be after cart has items)
	const checkoutNonce = classic.getCheckoutNonce( cfg.baseUrl, jar );
	sleep( thinkTime( 'filling_form' ) / 1000 );

	// 6. Submit checkout
	if ( checkoutNonce ) {
		const checkoutRes = http.post(
			`${ cfg.baseUrl }/?wc-ajax=checkout`,
			{
				billing_first_name: address.first_name,
				billing_last_name: address.last_name,
				billing_address_1: address.address_1,
				billing_city: address.city,
				billing_state: address.state || '',
				billing_postcode: address.postcode,
				billing_country: address.country,
				billing_phone: address.phone,
				billing_email: address.email,
				payment_method: 'cod',
				'woocommerce-process-checkout-nonce': checkoutNonce,
				_wp_http_referer: '/checkout/',
			},
			{ jar, tags: { name: 'classic-checkout-submit' } }
		);

		let success = false;
		try {
			success = JSON.parse( checkoutRes.body ).result === 'success';
		} catch ( e ) {
			// parse error
		}

		if ( success ) {
			journeySuccess.add( 1 );
		} else {
			journeyFail.add( 1 );
		}
	} else {
		journeyFail.add( 1 );
	}
}

function storeapiJourney( itemCount, coupon, address ) {
	const { jar, nonce } = storeapi.initSession( cfg.baseUrl );

	// 1. Browse shop
	const shopRes = http.get( `${ cfg.baseUrl }/shop/`, {
		jar,
		tags: { name: 'storeapi-shop' },
	} );
	check( shopRes, { 'shop 200': ( r ) => r.status === 200 } );
	sleep( thinkTime( 'browsing' ) / 1000 );

	// 2. Add items to cart
	for ( let i = 0; i < itemCount; i++ ) {
		const product = pickProduct( PRODUCTS );
		const productId = getProductId( product );

		const addRes = storeapi.addToCart(
			cfg.baseUrl, productId, 1, nonce, jar
		);

		if ( addRes.status >= 200 && addRes.status < 300 ) {
			itemsAdded.add( 1 );
		}

		if ( i < itemCount - 1 ) {
			sleep( thinkTime( 'adding' ) / 1000 );
		}
	}

	sleep( thinkTime( 'browsing' ) / 1000 );

	// 3. View cart
	http.get( `${ cfg.baseUrl }/cart/`, {
		jar,
		tags: { name: 'storeapi-cart' },
	} );
	storeapi.getCart( cfg.baseUrl, nonce, jar );
	sleep( thinkTime( 'cart_review' ) / 1000 );

	// 4. Apply coupon (45% chance)
	if ( coupon ) {
		storeapi.applyCoupon( cfg.baseUrl, coupon, nonce, jar );
		sleep( thinkTime( 'browsing' ) / 1000 );
	}

	// 5. View checkout page
	http.get( `${ cfg.baseUrl }/checkout/`, {
		jar,
		tags: { name: 'storeapi-checkout-page' },
		redirects: 5,
	} );
	sleep( thinkTime( 'filling_form' ) / 1000 );

	// 6. Submit checkout
	const checkoutPayload = {
		billing_address: {
			first_name: address.first_name,
			last_name: address.last_name,
			address_1: address.address_1,
			city: address.city,
			state: address.state || '',
			postcode: address.postcode,
			country: address.country,
			email: address.email,
			phone: address.phone,
		},
		shipping_address: {
			first_name: address.first_name,
			last_name: address.last_name,
			address_1: address.address_1,
			city: address.city,
			state: address.state || '',
			postcode: address.postcode,
			country: address.country,
		},
		payment_method: 'cod',
	};

	const checkoutRes = http.post(
		`${ cfg.baseUrl }/wp-json/wc/store/v1/checkout/`,
		JSON.stringify( checkoutPayload ),
		{
			headers: {
				'Content-Type': 'application/json',
				Nonce: nonce,
			},
			jar,
			tags: { name: 'storeapi-checkout-submit' },
		}
	);

	let success = false;
	try {
		success = JSON.parse( checkoutRes.body ).order_id > 0;
	} catch ( e ) {
		// parse error
	}

	if ( success ) {
		journeySuccess.add( 1 );
	} else {
		journeyFail.add( 1 );
	}
}

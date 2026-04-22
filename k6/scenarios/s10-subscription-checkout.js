/**
 * S10: Subscription + Mixed Cart Checkout
 *
 * Tests the most complex real-world scenario:
 * - Add a regular product (Magnesium variation)
 * - Add a subscription product (Magnesium Subscribe & Save)
 * - Update regular product quantity
 * - Apply coupon
 * - Checkout with subscription in cart
 *
 * Subscription checkout is heavier than regular because WC Subscriptions:
 * - Creates the initial order + a subscription object
 * - Sets up recurring payment schedule
 * - Processes subscription-specific hooks
 *
 * Usage:
 *   k6 run -e MODE=classic -e SKIP_NONCE=1 --duration 2m --vus 1 scenarios/s10-subscription-checkout.js
 *   k6 run -e MODE=storeapi -e SKIP_NONCE=1 --duration 2m --vus 1 scenarios/s10-subscription-checkout.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

const subCheckoutDuration = new Trend( 'sub_checkout_duration', true );
const mixedCartDuration = new Trend( 'mixed_cart_build', true );
const journeySuccess = new Counter( 'journey_success' );
const journeyFail = new Counter( 'journey_fail' );

export const options = {
	scenarios: {
		subscription: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
};

const mode = getMode();
const cfg = getConfig();

// Subscription product IDs differ between instances
const SUB_IDS = {
	classic: {
		vitd3_sub: 37372,
		omega3_sub: 37373,
		mag_sub: 37374,
	},
	storeapi: {
		vitd3_sub: 22748,
		omega3_sub: 22749,
		mag_sub: 22750,
	},
};

const subs = SUB_IDS[ mode ];

function think( min, max ) {
	sleep( ( min + Math.random() * ( max - min ) ) / 1000 );
}

export default function () {
	if ( mode === 'classic' ) {
		classicSubCheckout();
	} else {
		storeapiSubCheckout();
	}
}

function classicSubCheckout() {
	const { jar, nonces } = classic.initSession( cfg.baseUrl );

	// 1. Add regular Magnesium 200ml (variation)
	const buildStart = Date.now();
	http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
		{ product_id: '19', variation_id: '24', quantity: '1' },
		{ jar, tags: { name: 'classic-add-regular' } }
	);
	think( 500, 1000 );

	// 2. Add subscription product (Magnesium Subscribe & Save)
	http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
		{ product_id: String( subs.mag_sub ), quantity: '1' },
		{ jar, tags: { name: 'classic-add-subscription' } }
	);
	think( 500, 1000 );

	// 3. Add another subscription (Vitamin D3 Subscribe & Save)
	http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
		{ product_id: String( subs.vitd3_sub ), quantity: '1' },
		{ jar, tags: { name: 'classic-add-subscription' } }
	);
	mixedCartDuration.add( Date.now() - buildStart );
	think( 1000, 2000 );

	// 4. Apply coupon
	classic.applyCoupon( cfg.baseUrl, 'WELCOME10', jar, nonces.apply_coupon_nonce );
	think( 500, 1000 );

	// 5. Get checkout nonce and submit
	const checkoutNonce = classic.getCheckoutNonce( cfg.baseUrl, jar );
	think( 1000, 2000 );

	if ( checkoutNonce ) {
		const checkoutStart = Date.now();
		const res = http.post( `${ cfg.baseUrl }/?wc-ajax=checkout`, {
			billing_first_name: 'Aoife', billing_last_name: 'Murphy',
			billing_address_1: '42 Grafton Street', billing_city: 'Dublin',
			billing_state: 'D', billing_postcode: 'D02 YX88', billing_country: 'IE',
			billing_phone: '+35312345678',
			billing_email: `sub+${ Date.now() }${ Math.floor( Math.random() * 9999 ) }@mk.test`,
			payment_method: 'cod',
			'woocommerce-process-checkout-nonce': checkoutNonce,
			_wp_http_referer: '/checkout/',
		}, { jar, tags: { name: 'classic-sub-checkout' } } );
		subCheckoutDuration.add( Date.now() - checkoutStart );

		try {
			const data = JSON.parse( res.body );
			if ( data.result === 'success' || data.reload === true ) {
				journeySuccess.add( 1 );
				return;
			}
		} catch ( e ) { /* */ }
	}
	journeyFail.add( 1 );
}

function storeapiSubCheckout() {
	const { jar, nonce } = storeapi.initSession( cfg.baseUrl );

	// 1. Add regular Magnesium 200ml (variation)
	const buildStart = Date.now();
	storeapi.addToCart( cfg.baseUrl, 24, 1, nonce, jar );
	think( 500, 1000 );

	// 2. Add subscription product
	http.post( `${ cfg.baseUrl }/wp-json/wc/store/v1/cart/add-item/`,
		JSON.stringify( { id: subs.mag_sub, quantity: 1 } ),
		{
			headers: { 'Content-Type': 'application/json', Nonce: nonce },
			jar, tags: { name: 'storeapi-add-subscription' },
		}
	);
	think( 500, 1000 );

	// 3. Add another subscription
	http.post( `${ cfg.baseUrl }/wp-json/wc/store/v1/cart/add-item/`,
		JSON.stringify( { id: subs.vitd3_sub, quantity: 1 } ),
		{
			headers: { 'Content-Type': 'application/json', Nonce: nonce },
			jar, tags: { name: 'storeapi-add-subscription' },
		}
	);
	mixedCartDuration.add( Date.now() - buildStart );
	think( 1000, 2000 );

	// 4. Apply coupon
	storeapi.applyCoupon( cfg.baseUrl, 'WELCOME10', nonce, jar );
	think( 500, 1000 );

	// 5. Checkout
	think( 1000, 2000 );
	const checkoutStart = Date.now();
	const res = http.post( `${ cfg.baseUrl }/wp-json/wc/store/v1/checkout/`,
		JSON.stringify( {
			billing_address: {
				first_name: 'Aoife', last_name: 'Murphy',
				address_1: '42 Grafton Street', city: 'Dublin',
				state: 'D', postcode: 'D02 YX88', country: 'IE',
				email: `sub+${ Date.now() }${ Math.floor( Math.random() * 9999 ) }@mk.test`,
				phone: '+35312345678',
			},
			shipping_address: {
				first_name: 'Aoife', last_name: 'Murphy',
				address_1: '42 Grafton Street', city: 'Dublin',
				state: 'D', postcode: 'D02 YX88', country: 'IE',
			},
			payment_method: 'cod',
		} ),
		{
			headers: { 'Content-Type': 'application/json', Nonce: nonce },
			jar, tags: { name: 'storeapi-sub-checkout' },
		}
	);
	subCheckoutDuration.add( Date.now() - checkoutStart );

	try {
		if ( JSON.parse( res.body ).order_id > 0 ) {
			journeySuccess.add( 1 );
			return;
		}
	} catch ( e ) { /* */ }
	journeyFail.add( 1 );
}

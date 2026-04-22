/**
 * S7: Full User Journey
 *
 * Simulates a realistic user flow: browse shop -> add to cart ->
 * view cart -> apply coupon -> checkout. Includes think time between
 * steps to simulate real user behaviour.
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s7-full-journey.js
 *   k6 run -e MODE=storeapi scenarios/s7-full-journey.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

export const options = {
	scenarios: {
		journey: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
};

const mode = getMode();
const cfg = getConfig();

function thinkTime() {
	sleep( 1 + Math.random() * 2 );
}

export default function () {
	if ( mode === 'classic' ) {
		classicJourney();
	} else {
		storeapiJourney();
	}
}

function classicJourney() {
	// 1. Browse shop page
	const jar = classic.initSession( cfg.baseUrl );
	const shopRes = http.get( `${ cfg.baseUrl }/shop/`, {
		jar,
		tags: { name: 'classic-shop-page' },
	} );
	check( shopRes, { 'shop 200': ( r ) => r.status === 200 } );
	thinkTime();

	// 2. Add to cart
	classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
	thinkTime();

	// 3. View cart
	const cartRes = http.get( `${ cfg.baseUrl }/cart/`, {
		jar,
		tags: { name: 'classic-cart-page' },
	} );
	check( cartRes, { 'cart 200': ( r ) => r.status === 200 } );
	classic.getCartFragments( cfg.baseUrl, jar );
	thinkTime();

	// 4. Apply coupon
	classic.applyCoupon( cfg.baseUrl, cfg.couponCode, jar );
	thinkTime();

	// 5. Proceed to checkout
	const nonce = classic.getCheckoutNonce( cfg.baseUrl, jar );
	thinkTime();

	// 6. Submit checkout
	if ( nonce ) {
		classic.checkout( cfg.baseUrl, nonce, jar );
	}
}

function storeapiJourney() {
	// 1. Browse shop page
	const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
	const shopRes = http.get( `${ cfg.baseUrl }/shop/`, {
		jar,
		tags: { name: 'storeapi-shop-page' },
	} );
	check( shopRes, { 'shop 200': ( r ) => r.status === 200 } );
	thinkTime();

	// 2. Add to cart
	storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
	thinkTime();

	// 3. View cart
	const cartPageRes = http.get( `${ cfg.baseUrl }/cart/`, {
		jar,
		tags: { name: 'storeapi-cart-page' },
	} );
	check( cartPageRes, { 'cart 200': ( r ) => r.status === 200 } );
	storeapi.getCart( cfg.baseUrl, nonce, jar );
	thinkTime();

	// 4. Apply coupon
	storeapi.applyCoupon( cfg.baseUrl, cfg.couponCode, nonce, jar );
	thinkTime();

	// 5. View checkout page
	const checkoutPageRes = http.get( `${ cfg.baseUrl }/checkout/`, {
		jar,
		tags: { name: 'storeapi-checkout-page' },
		redirects: 5,
	} );
	check( checkoutPageRes, {
		'checkout page 200': ( r ) => r.status === 200,
	} );
	thinkTime();

	// 6. Submit checkout
	storeapi.checkout( cfg.baseUrl, nonce, jar );
}

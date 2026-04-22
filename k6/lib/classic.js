/**
 * Classic (wc-ajax) helper functions for k6.
 *
 * All functions operate on the classic WooCommerce shortcode-based
 * cart/checkout which uses /?wc-ajax=<endpoint> for AJAX operations.
 */

import http from 'k6/http';
import { check } from 'k6';

/**
 * Initialise a WC session and fetch all required nonces.
 *
 * @param {string} baseUrl Site base URL.
 * @return {object} { jar, nonces } — cookie jar and nonce object.
 */
export function initSession( baseUrl ) {
	const jar = http.cookieJar();
	const res = http.get( `${ baseUrl }/`, { jar } );
	check( res, { 'session init 200': ( r ) => r.status === 200 } );

	const nonceRes = http.get( `${ baseUrl }/?k6_get_nonce=all`, { jar } );
	let nonces = {};
	try {
		nonces = JSON.parse( nonceRes.body );
	} catch ( e ) {
		// nonces will be empty
	}

	return { jar, nonces };
}

/**
 * Add a product to cart via wc-ajax.
 *
 * @param {string} baseUrl   Site base URL.
 * @param {number} productId Product ID.
 * @param {number} quantity  Quantity to add.
 * @param {object} jar       Cookie jar.
 * @return {object} HTTP response.
 */
export function addToCart( baseUrl, productId, quantity, jar ) {
	const res = http.post(
		`${ baseUrl }/?wc-ajax=add_to_cart`,
		{ product_id: productId, quantity: quantity },
		{
			jar,
			tags: { name: 'wc-ajax-add_to_cart' },
		}
	);
	check( res, {
		'add_to_cart 200': ( r ) => r.status === 200,
		'has fragments': ( r ) => {
			try {
				return JSON.parse( r.body ).fragments !== undefined;
			} catch ( e ) {
				return false;
			}
		},
	} );
	return res;
}

/**
 * Get cart fragments (view cart).
 *
 * @param {string} baseUrl Site base URL.
 * @param {object} jar     Cookie jar.
 * @return {object} HTTP response.
 */
export function getCartFragments( baseUrl, jar ) {
	const res = http.post(
		`${ baseUrl }/?wc-ajax=get_refreshed_fragments`,
		{},
		{
			jar,
			tags: { name: 'wc-ajax-get_refreshed_fragments' },
		}
	);
	check( res, {
		'fragments 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Apply a coupon via wc-ajax.
 *
 * @param {string} baseUrl    Site base URL.
 * @param {string} couponCode Coupon code.
 * @param {object} jar        Cookie jar.
 * @return {object} HTTP response.
 */
export function applyCoupon( baseUrl, couponCode, jar, nonce ) {
	const payload = { coupon_code: couponCode };
	if ( nonce ) {
		payload.security = nonce;
	}
	const res = http.post(
		`${ baseUrl }/?wc-ajax=apply_coupon`,
		payload,
		{
			jar,
			tags: { name: 'wc-ajax-apply_coupon' },
		}
	);
	check( res, {
		'apply_coupon 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Remove a coupon via wc-ajax.
 *
 * @param {string} baseUrl    Site base URL.
 * @param {string} couponCode Coupon code.
 * @param {object} jar        Cookie jar.
 * @return {object} HTTP response.
 */
export function removeCoupon( baseUrl, couponCode, jar, nonce ) {
	const payload = { coupon: couponCode };
	if ( nonce ) {
		payload.security = nonce;
	}
	const res = http.post(
		`${ baseUrl }/?wc-ajax=remove_coupon`,
		payload,
		{
			jar,
			tags: { name: 'wc-ajax-remove_coupon' },
		}
	);
	check( res, {
		'remove_coupon 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Get checkout nonce from the k6-helper endpoint.
 *
 * Uses a lightweight PHP endpoint (not REST API) that returns a nonce
 * bound to the current session.
 *
 * @param {string} baseUrl Site base URL.
 * @param {object} jar     Cookie jar.
 * @return {string|null} Nonce value.
 */
export function getCheckoutNonce( baseUrl, jar ) {
	const res = http.get( `${ baseUrl }/?k6_get_nonce=checkout`, {
		jar,
		tags: { name: 'classic-get-nonce' },
	} );
	try {
		return JSON.parse( res.body ).checkout_nonce;
	} catch ( e ) {
		return null;
	}
}

/**
 * Submit checkout via wc-ajax.
 *
 * @param {string} baseUrl Site base URL.
 * @param {string} nonce   Checkout nonce.
 * @param {object} jar     Cookie jar.
 * @return {object} HTTP response.
 */
export function checkout( baseUrl, nonce, jar ) {
	const payload = {
		billing_first_name: 'k6',
		billing_last_name: 'Test',
		billing_company: '',
		billing_country: 'DE',
		billing_address_1: '123 Test Street',
		billing_address_2: '',
		billing_city: 'Berlin',
		billing_state: '',
		billing_postcode: '10115',
		billing_phone: '01234567890',
		billing_email: `k6test+${ Date.now() }@example.com`,
		order_comments: '',
		payment_method: 'cod',
		'woocommerce-process-checkout-nonce': nonce,
		_wp_http_referer: '/checkout/',
	};

	const res = http.post(
		`${ baseUrl }/?wc-ajax=checkout`,
		payload,
		{
			jar,
			tags: { name: 'wc-ajax-checkout' },
		}
	);
	check( res, {
		'checkout 200': ( r ) => r.status === 200,
		'checkout success': ( r ) => {
			try {
				return JSON.parse( r.body ).result === 'success';
			} catch ( e ) {
				return false;
			}
		},
	} );
	return res;
}

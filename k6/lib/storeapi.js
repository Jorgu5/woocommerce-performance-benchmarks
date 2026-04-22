/**
 * Store API helper functions for k6.
 *
 * All functions operate on the WooCommerce block-based cart/checkout
 * which uses the REST Store API at /wp-json/wc/store/v1/*.
 */

import http from 'k6/http';
import { check } from 'k6';

// Trailing slashes are required — WordPress 301-redirects without them,
// which turns POST requests into GET (losing the body).
const API_PREFIX = '/wp-json/wc/store/v1';
const NONCE_ENDPOINT = '/wp-json/k6-helper/v1/nonce/';

/**
 * Initialise a WC session and fetch a Store API nonce.
 *
 * @param {string} baseUrl Site base URL.
 * @return {object} { jar, nonce } - cookie jar and nonce string.
 */
export function initSession( baseUrl ) {
	const jar = http.cookieJar();

	http.get( `${ baseUrl }/`, { jar } );

	// When woocommerce_store_api_disable_nonce_check is active,
	// we can skip the nonce fetch entirely — saves one HTTP roundtrip.
	const skipNonce = __ENV.SKIP_NONCE === '1';

	let nonce = 'disabled';
	if ( ! skipNonce ) {
		const nonceRes = http.get( `${ baseUrl }${ NONCE_ENDPOINT }`, { jar } );
		try {
			nonce = JSON.parse( nonceRes.body ).nonce;
		} catch ( e ) {
			console.error( 'Failed to get Store API nonce:', nonceRes.body );
		}

		check( nonceRes, {
			'nonce acquired': () => nonce.length > 0,
		} );
	}

	return { jar, nonce };
}

/**
 * Build standard headers for Store API requests.
 *
 * @param {string} nonce Store API nonce.
 * @return {object} Headers object.
 */
function headers( nonce ) {
	return {
		'Content-Type': 'application/json',
		Nonce: nonce,
	};
}

/**
 * Add a product to cart via Store API.
 *
 * @param {string} baseUrl   Site base URL.
 * @param {number} productId Product ID.
 * @param {number} quantity  Quantity to add.
 * @param {string} nonce     Store API nonce.
 * @param {object} jar       Cookie jar.
 * @return {object} HTTP response.
 */
export function addToCart( baseUrl, productId, quantity, nonce, jar ) {
	const res = http.post(
		`${ baseUrl }${ API_PREFIX }/cart/add-item/`,
		JSON.stringify( { id: productId, quantity } ),
		{
			headers: headers( nonce ),
			jar,
			tags: { name: 'store-api-add-item' },
		}
	);
	check( res, {
		'add-item 200': ( r ) => r.status >= 200 && r.status < 300,
		'has items': ( r ) => {
			try {
				return JSON.parse( r.body ).items.length > 0;
			} catch ( e ) {
				return false;
			}
		},
	} );
	return res;
}

/**
 * Get cart state via Store API.
 *
 * @param {string} baseUrl Site base URL.
 * @param {string} nonce   Store API nonce.
 * @param {object} jar     Cookie jar.
 * @return {object} HTTP response.
 */
export function getCart( baseUrl, nonce, jar ) {
	const res = http.get(
		`${ baseUrl }${ API_PREFIX }/cart/`,
		{
			headers: headers( nonce ),
			jar,
			tags: { name: 'store-api-get-cart' },
		}
	);
	check( res, {
		'get-cart 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Update cart item quantity via Store API.
 *
 * @param {string} baseUrl  Site base URL.
 * @param {string} itemKey  Cart item key.
 * @param {number} quantity New quantity.
 * @param {string} nonce    Store API nonce.
 * @param {object} jar      Cookie jar.
 * @return {object} HTTP response.
 */
export function updateItem( baseUrl, itemKey, quantity, nonce, jar ) {
	const res = http.post(
		`${ baseUrl }${ API_PREFIX }/cart/update-item/`,
		JSON.stringify( { key: itemKey, quantity } ),
		{
			headers: headers( nonce ),
			jar,
			tags: { name: 'store-api-update-item' },
		}
	);
	check( res, {
		'update-item 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Apply a coupon via Store API.
 *
 * @param {string} baseUrl    Site base URL.
 * @param {string} couponCode Coupon code.
 * @param {string} nonce      Store API nonce.
 * @param {object} jar        Cookie jar.
 * @return {object} HTTP response.
 */
export function applyCoupon( baseUrl, couponCode, nonce, jar ) {
	const res = http.post(
		`${ baseUrl }${ API_PREFIX }/cart/apply-coupon/`,
		JSON.stringify( { code: couponCode } ),
		{
			headers: headers( nonce ),
			jar,
			tags: { name: 'store-api-apply-coupon' },
		}
	);
	check( res, {
		'apply-coupon 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Remove a coupon via Store API.
 *
 * @param {string} baseUrl    Site base URL.
 * @param {string} couponCode Coupon code.
 * @param {string} nonce      Store API nonce.
 * @param {object} jar        Cookie jar.
 * @return {object} HTTP response.
 */
export function removeCoupon( baseUrl, couponCode, nonce, jar ) {
	const res = http.post(
		`${ baseUrl }${ API_PREFIX }/cart/remove-coupon/`,
		JSON.stringify( { code: couponCode } ),
		{
			headers: headers( nonce ),
			jar,
			tags: { name: 'store-api-remove-coupon' },
		}
	);
	check( res, {
		'remove-coupon 200': ( r ) => r.status === 200,
	} );
	return res;
}

/**
 * Submit checkout via Store API.
 *
 * @param {string} baseUrl Site base URL.
 * @param {string} nonce   Store API nonce.
 * @param {object} jar     Cookie jar.
 * @return {object} HTTP response.
 */
export function checkout( baseUrl, nonce, jar ) {
	const payload = {
		billing_address: {
			first_name: 'k6',
			last_name: 'Test',
			company: '',
			address_1: '123 Test Street',
			address_2: '',
			city: 'Berlin',
			state: '',
			postcode: '10115',
			country: 'DE',
			email: `k6test+${ Date.now() }@example.com`,
			phone: '01234567890',
		},
		shipping_address: {
			first_name: 'k6',
			last_name: 'Test',
			company: '',
			address_1: '123 Test Street',
			address_2: '',
			city: 'Berlin',
			state: '',
			postcode: '10115',
			country: 'DE',
		},
		payment_method: 'cod',
	};

	const res = http.post(
		`${ baseUrl }${ API_PREFIX }/checkout/`,
		JSON.stringify( payload ),
		{
			headers: headers( nonce ),
			jar,
			tags: { name: 'store-api-checkout' },
		}
	);
	check( res, {
		'checkout 200': ( r ) => r.status >= 200 && r.status < 300,
		'order created': ( r ) => {
			try {
				return JSON.parse( r.body ).order_id > 0;
			} catch ( e ) {
				return false;
			}
		},
	} );
	return res;
}

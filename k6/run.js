/**
 * k6 Runner — Fair comparison of classic wc-ajax vs Store API.
 *
 * Key design decisions for fair benchmarking:
 * - Session + nonce acquired ONCE per VU (not per iteration)
 * - Only the target operation is tagged for comparison metrics
 * - Setup overhead is excluded from the main comparison metric
 *
 * Usage:
 *   k6 run -e MODE=classic -e SCENARIO=s1 -e PROFILE=baseline run.js
 *   k6 run -e MODE=storeapi -e SCENARIO=s6 -e PROFILE=heavy run.js
 */

import { getMode, getConfig, PRODUCTS, getProductId } from './config.js';
import * as classic from './lib/classic.js';
import * as storeapi from './lib/storeapi.js';
import { pickProduct, pickItemCount, pickCoupon, pickAddress, thinkTime as realisticThinkTime } from './lib/realistic-flow.js';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// ── Custom metrics for fair comparison ─────────────────────────────

const targetDuration = new Trend( 'target_duration', true );
const targetSuccess = new Counter( 'target_success' );
const targetFail = new Counter( 'target_fail' );

// ── Load profiles ──────────────────────────────────────────────────

const PROFILES = {
	baseline: {
		stages: [ { duration: '2m', target: 1 } ],
	},
	light: {
		stages: [
			{ duration: '1m', target: 50 },
			{ duration: '5m', target: 50 },
			{ duration: '1m', target: 0 },
		],
	},
	medium: {
		stages: [
			{ duration: '2m', target: 200 },
			{ duration: '5m', target: 200 },
			{ duration: '1m', target: 0 },
		],
	},
	heavy: {
		stages: [
			{ duration: '3m', target: 500 },
			{ duration: '5m', target: 500 },
			{ duration: '1m', target: 0 },
		],
	},
	breaking: {
		stages: [ { duration: '10m', target: 500 } ],
		thresholds: {
			http_req_failed: [ { threshold: 'rate<0.50', abortOnFail: true } ],
			http_req_duration: [
				{ threshold: 'p(95)<30000', abortOnFail: true },
			],
		},
	},
};

const profileName = ( __ENV.PROFILE || 'baseline' ).toLowerCase();
const profile = PROFILES[ profileName ];
if ( ! profile ) {
	throw new Error(
		`Invalid PROFILE "${ profileName }". Use: ${ Object.keys( PROFILES ).join( ', ' ) }`
	);
}

const isBaseline = profileName === 'baseline';

export const options = {
	scenarios: {
		benchmark: isBaseline
			? { executor: 'constant-vus', vus: 1, duration: '2m' }
			: {
				executor: 'ramping-vus',
				startVUs: 0,
				stages: profile.stages,
				gracefulRampDown: '30s',
			},
	},
	thresholds: {
		target_duration: [ 'p(95)<5000' ],
		...( profile.thresholds || {} ),
	},
	summaryTrendStats: [
		'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)',
	],
};

// ── State ──────────────────────────────────────────────────────────

const mode = getMode();
const cfg = getConfig();

// Per-VU session state — initialized on first iteration, reused after.
// k6 VUs are single-threaded so this is safe without locks.
let vuSession = null;

function getSession() {
	if ( vuSession ) {
		return vuSession;
	}

	if ( mode === 'classic' ) {
		const { jar, nonces } = classic.initSession( cfg.baseUrl );
		vuSession = { jar, nonces };
	} else {
		const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
		vuSession = { jar, nonce };
	}

	return vuSession;
}

// Track the target operation duration
function measureTarget( fn ) {
	const start = Date.now();
	const result = fn();
	const dur = Date.now() - start;
	targetDuration.add( dur );

	let success = false;
	if ( result && result.status ) {
		success = result.status >= 200 && result.status < 400;
	}
	if ( success ) {
		targetSuccess.add( 1 );
	} else {
		targetFail.add( 1 );
	}
	return result;
}

function thinkTime() {
	sleep( 1 + Math.random() * 2 );
}

// ── Scenario implementations ───────────────────────────────────────

const SCENARIOS = {
	// S1: Add to Cart — measures only the add-to-cart call
	s1() {
		if ( mode === 'classic' ) {
			const { jar } = getSession();
			measureTarget( () =>
				classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar )
			);
		} else {
			const { jar, nonce } = getSession();
			measureTarget( () =>
				storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar )
			);
		}
	},

	// S2: View Cart — add item then measure cart retrieval
	s2() {
		if ( mode === 'classic' ) {
			const { jar } = getSession();
			classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
			measureTarget( () =>
				classic.getCartFragments( cfg.baseUrl, jar )
			);
		} else {
			const { jar, nonce } = getSession();
			storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
			measureTarget( () =>
				storeapi.getCart( cfg.baseUrl, nonce, jar )
			);
		}
	},

	// S3: Update Quantity — add item then measure quantity update
	s3() {
		if ( mode === 'classic' ) {
			const { jar } = getSession();
			classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
			measureTarget( () => {
				const cartPage = http.get( `${ cfg.baseUrl }/cart/`, { jar } );
				const nm = cartPage.body.match(
					/name="woocommerce-cart-nonce"[^>]*value="([^"]+)"/
				);
				const km = cartPage.body.match(
					/name="cart\[([a-f0-9]+)\]\[qty\]"/
				);
				if ( nm && km ) {
					const payload = {};
					payload[ `cart[${ km[ 1 ] }][qty]` ] = '3';
					payload[ 'woocommerce-cart-nonce' ] = nm[ 1 ];
					payload.update_cart = 'Update cart';
					payload._wp_http_referer = '/cart/';
					return http.post( `${ cfg.baseUrl }/cart/`, payload, {
						jar,
						tags: { name: 'classic-update-cart' },
						redirects: 0,
					} );
				}
				return { status: 0 };
			} );
		} else {
			const { jar, nonce } = getSession();
			const addRes = storeapi.addToCart(
				cfg.baseUrl, cfg.productId, 1, nonce, jar
			);
			let itemKey = '';
			try {
				itemKey = JSON.parse( addRes.body ).items[ 0 ].key;
			} catch ( e ) {
				return;
			}
			measureTarget( () =>
				storeapi.updateItem( cfg.baseUrl, itemKey, 3, nonce, jar )
			);
		}
	},

	// S4: Apply Coupon — add item then measure coupon application
	s4() {
		if ( mode === 'classic' ) {
			const { jar, nonces } = getSession();
			classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
			measureTarget( () =>
				classic.applyCoupon(
					cfg.baseUrl, cfg.couponCode, jar,
					nonces.apply_coupon_nonce
				)
			);
		} else {
			const { jar, nonce } = getSession();
			storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
			measureTarget( () =>
				storeapi.applyCoupon(
					cfg.baseUrl, cfg.couponCode, nonce, jar
				)
			);
		}
	},

	// S5: Remove Coupon — add item, apply coupon, measure removal
	s5() {
		if ( mode === 'classic' ) {
			const { jar, nonces } = getSession();
			classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
			classic.applyCoupon(
				cfg.baseUrl, cfg.couponCode, jar,
				nonces.apply_coupon_nonce
			);
			measureTarget( () =>
				classic.removeCoupon(
					cfg.baseUrl, cfg.couponCode, jar,
					nonces.remove_coupon_nonce
				)
			);
		} else {
			const { jar, nonce } = getSession();
			storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
			storeapi.applyCoupon( cfg.baseUrl, cfg.couponCode, nonce, jar );
			measureTarget( () =>
				storeapi.removeCoupon(
					cfg.baseUrl, cfg.couponCode, nonce, jar
				)
			);
		}
	},

	// S6: Checkout — add item then measure full checkout
	s6() {
		if ( mode === 'classic' ) {
			const { jar } = getSession();
			classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
			// Checkout nonce must be fetched after cart has items
			const n = classic.getCheckoutNonce( cfg.baseUrl, jar );
			if ( n ) {
				measureTarget( () =>
					classic.checkout( cfg.baseUrl, n, jar )
				);
			}
		} else {
			const { jar, nonce } = getSession();
			storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
			measureTarget( () =>
				storeapi.checkout( cfg.baseUrl, nonce, jar )
			);
		}
	},

	// S7: Full Journey — shop → add → cart → coupon → checkout with think time
	s7() {
		// S7 always creates a fresh session (simulates new visitor)
		vuSession = null;

		if ( mode === 'classic' ) {
			const { jar, nonces } = classic.initSession( cfg.baseUrl );
			http.get( `${ cfg.baseUrl }/shop/`, {
				jar,
				tags: { name: 'classic-shop-page' },
			} );
			thinkTime();
			classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
			thinkTime();
			http.get( `${ cfg.baseUrl }/cart/`, {
				jar,
				tags: { name: 'classic-cart-page' },
			} );
			classic.getCartFragments( cfg.baseUrl, jar );
			thinkTime();
			classic.applyCoupon(
				cfg.baseUrl, cfg.couponCode, jar,
				nonces.apply_coupon_nonce
			);
			thinkTime();
			const checkoutN = classic.getCheckoutNonce( cfg.baseUrl, jar );
			if ( checkoutN ) {
				classic.checkout( cfg.baseUrl, checkoutN, jar );
			}
		} else {
			const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
			http.get( `${ cfg.baseUrl }/shop/`, {
				jar,
				tags: { name: 'storeapi-shop-page' },
			} );
			thinkTime();
			storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
			thinkTime();
			http.get( `${ cfg.baseUrl }/cart/`, {
				jar,
				tags: { name: 'storeapi-cart-page' },
			} );
			storeapi.getCart( cfg.baseUrl, nonce, jar );
			thinkTime();
			storeapi.applyCoupon( cfg.baseUrl, cfg.couponCode, nonce, jar );
			thinkTime();
			http.get( `${ cfg.baseUrl }/checkout/`, {
				jar,
				tags: { name: 'storeapi-checkout-page' },
				redirects: 5,
			} );
			thinkTime();
			storeapi.checkout( cfg.baseUrl, nonce, jar );
		}
	},
};

// ── Main ───────────────────────────────────────────────────────────

const scenarioName = ( __ENV.SCENARIO || 's1' ).toLowerCase();
const scenarioFn = SCENARIOS[ scenarioName ];
if ( ! scenarioFn ) {
	throw new Error(
		`Invalid SCENARIO "${ scenarioName }". Use: ${ Object.keys( SCENARIOS ).join( ', ' ) }`
	);
}

export default function () {
	scenarioFn();
}

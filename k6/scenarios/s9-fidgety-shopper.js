/**
 * S9: Fidgety Shopper — Heavy Cart Interaction Test
 *
 * Simulates a real customer who browses, adds items, changes their mind,
 * updates quantities, removes items, applies/removes coupons, then checks out.
 *
 * This is the scenario where Store API should outperform classic because
 * classic makes a full server roundtrip for EVERY cart interaction, while
 * Store API handles many interactions client-side.
 *
 * Typical flow (10-15 cart operations per checkout):
 * 1. Browse shop
 * 2. Add Magnesium 100ml (top seller)
 * 3. Add Vitamin C Orange
 * 4. Change Magnesium quantity to 2
 * 5. Add Omega-3
 * 6. Apply WELCOME10 coupon
 * 7. Remove Omega-3 (changed mind)
 * 8. Add Multivitamin instead
 * 9. Change Vitamin C quantity to 2
 * 10. Remove coupon (trying a different one)
 * 11. Apply BUNDLE15 coupon
 * 12. View cart totals
 * 13. Proceed to checkout
 * 14. Submit order
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s9-fidgety-shopper.js
 *   k6 run -e MODE=storeapi -e SKIP_NONCE=1 scenarios/s9-fidgety-shopper.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

const journeyDuration = new Trend( 'journey_duration', true );
const cartOpDuration = new Trend( 'cart_op_duration', true );
const cartOpsCount = new Counter( 'cart_ops_total' );
const journeySuccess = new Counter( 'journey_success' );
const journeyFail = new Counter( 'journey_fail' );

export const options = {
	scenarios: {
		fidgety: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
};

const mode = getMode();
const cfg = getConfig();

function measureCartOp( fn ) {
	const start = Date.now();
	const result = fn();
	cartOpDuration.add( Date.now() - start );
	cartOpsCount.add( 1 );
	return result;
}

function think( min, max ) {
	sleep( ( min + Math.random() * ( max - min ) ) / 1000 );
}

export default function () {
	const journeyStart = Date.now();

	if ( mode === 'classic' ) {
		classicFidgety();
	} else {
		storerapiFidgety();
	}

	journeyDuration.add( Date.now() - journeyStart );
}

function classicFidgety() {
	const { jar, nonces } = classic.initSession( cfg.baseUrl );

	// 1. Browse shop
	http.get( `${ cfg.baseUrl }/shop/`, { jar, tags: { name: 'shop' } } );
	think( 1000, 2000 );

	// 2. Add Magnesium 100ml (variation)
	measureCartOp( () =>
		http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
			{ product_id: '19', variation_id: '23', quantity: '1' },
			{ jar, tags: { name: 'classic-add' } }
		)
	);
	think( 500, 1000 );

	// 3. Add Vitamin C Orange (variation)
	measureCartOp( () =>
		http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
			{ product_id: '18', variation_id: '21', quantity: '1' },
			{ jar, tags: { name: 'classic-add' } }
		)
	);
	think( 500, 1000 );

	// 4. View cart + get fragments (user checking their cart)
	const cartPage = http.get( `${ cfg.baseUrl }/cart/`, { jar, tags: { name: 'cart-page' } } );
	measureCartOp( () =>
		classic.getCartFragments( cfg.baseUrl, jar )
	);
	think( 1000, 2000 );

	// 5. Change Magnesium quantity to 2 (requires cart page nonce + item key)
	const cartNonceMatch = cartPage.body.match(
		/name="woocommerce-cart-nonce"[^>]*value="([^"]+)"/
	);
	const cartKeys = [ ...cartPage.body.matchAll(
		/name="cart\[([a-f0-9]+)\]\[qty\]"/g
	) ].map( m => m[ 1 ] );

	if ( cartNonceMatch && cartKeys.length > 0 ) {
		const updatePayload = { 'woocommerce-cart-nonce': cartNonceMatch[ 1 ], update_cart: 'Update cart', _wp_http_referer: '/cart/' };
		cartKeys.forEach( ( key, i ) => {
			updatePayload[ `cart[${ key }][qty]` ] = i === 0 ? '2' : '1';
		} );
		measureCartOp( () =>
			http.post( `${ cfg.baseUrl }/cart/`, updatePayload,
				{ jar, tags: { name: 'classic-update-qty' }, redirects: 0 }
			)
		);
	}
	think( 500, 1000 );

	// 6. Add Omega-3 (simple product)
	measureCartOp( () =>
		http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
			{ product_id: '16', quantity: '1' },
			{ jar, tags: { name: 'classic-add' } }
		)
	);
	think( 1000, 2000 );

	// 7. Apply WELCOME10 coupon
	measureCartOp( () =>
		classic.applyCoupon( cfg.baseUrl, 'WELCOME10', jar, nonces.apply_coupon_nonce )
	);
	think( 500, 1500 );

	// 8. Remove Omega-3 (reload cart to get remove link)
	const cartPage2 = http.get( `${ cfg.baseUrl }/cart/`, { jar, tags: { name: 'cart-page' } } );
	const removeMatch = cartPage2.body.match( /class="remove"[^>]*href="([^"]*remove_item[^"]*)"/ );
	if ( removeMatch ) {
		measureCartOp( () =>
			http.get( removeMatch[ 1 ], { jar, tags: { name: 'classic-remove' }, redirects: 0 } )
		);
	}
	think( 500, 1000 );

	// 9. Add Multivitamin instead (variation)
	measureCartOp( () =>
		http.post( `${ cfg.baseUrl }/?wc-ajax=add_to_cart`,
			{ product_id: '20', variation_id: '26', quantity: '1' },
			{ jar, tags: { name: 'classic-add' } }
		)
	);
	think( 500, 1000 );

	// 10. Remove coupon
	measureCartOp( () =>
		classic.removeCoupon( cfg.baseUrl, 'WELCOME10', jar, nonces.remove_coupon_nonce )
	);
	think( 300, 800 );

	// 11. Apply BUNDLE15 coupon
	measureCartOp( () =>
		classic.applyCoupon( cfg.baseUrl, 'BUNDLE15', jar, nonces.apply_coupon_nonce )
	);
	think( 500, 1000 );

	// 12. View cart one more time (final review)
	http.get( `${ cfg.baseUrl }/cart/`, { jar, tags: { name: 'cart-page' } } );
	measureCartOp( () =>
		classic.getCartFragments( cfg.baseUrl, jar )
	);
	think( 1000, 3000 );

	// 13. Get checkout nonce + submit
	const checkoutNonce = classic.getCheckoutNonce( cfg.baseUrl, jar );
	think( 2000, 4000 );

	if ( checkoutNonce ) {
		const checkoutRes = http.post( `${ cfg.baseUrl }/?wc-ajax=checkout`, {
			billing_first_name: 'Aoife', billing_last_name: 'Murphy',
			billing_address_1: '42 Grafton Street', billing_city: 'Dublin',
			billing_state: 'D', billing_postcode: 'D02 YX88', billing_country: 'IE',
			billing_phone: '+35312345678',
			billing_email: `test+${ Date.now() }${ Math.floor( Math.random() * 9999 ) }@mk.test`,
			payment_method: 'cod',
			'woocommerce-process-checkout-nonce': checkoutNonce,
			_wp_http_referer: '/checkout/',
		}, { jar, tags: { name: 'classic-checkout' } } );

		try {
			if ( JSON.parse( checkoutRes.body ).result === 'success' ) {
				journeySuccess.add( 1 );
				return;
			}
		} catch ( e ) { /* */ }
	}
	journeyFail.add( 1 );
}

function storerapiFidgety() {
	const { jar, nonce } = storeapi.initSession( cfg.baseUrl );

	// 1. Browse shop
	http.get( `${ cfg.baseUrl }/shop/`, { jar, tags: { name: 'shop' } } );
	think( 1000, 2000 );

	// 2. Add Magnesium 100ml
	let cartState = measureCartOp( () =>
		storeapi.addToCart( cfg.baseUrl, 23, 1, nonce, jar )
	);
	think( 500, 1000 );

	// 3. Add Vitamin C Orange
	cartState = measureCartOp( () =>
		storeapi.addToCart( cfg.baseUrl, 21, 1, nonce, jar )
	);
	think( 500, 1000 );

	// 4. View cart
	http.get( `${ cfg.baseUrl }/cart/`, { jar, tags: { name: 'cart-page' } } );
	cartState = measureCartOp( () =>
		storeapi.getCart( cfg.baseUrl, nonce, jar )
	);
	think( 1000, 2000 );

	// 5. Change Magnesium quantity to 2
	let items = [];
	try { items = JSON.parse( cartState.body ).items || []; } catch ( e ) { /* */ }
	const magItem = items.find( i => i.id === 23 );
	if ( magItem ) {
		measureCartOp( () =>
			storeapi.updateItem( cfg.baseUrl, magItem.key, 2, nonce, jar )
		);
	}
	think( 500, 1000 );

	// 6. Add Omega-3
	cartState = measureCartOp( () =>
		storeapi.addToCart( cfg.baseUrl, 16, 1, nonce, jar )
	);
	think( 1000, 2000 );

	// 7. Apply WELCOME10 coupon
	measureCartOp( () =>
		storeapi.applyCoupon( cfg.baseUrl, 'WELCOME10', nonce, jar )
	);
	think( 500, 1500 );

	// 8. Remove Omega-3 (get item key from last cart state)
	try { items = JSON.parse( cartState.body ).items || []; } catch ( e ) { /* */ }
	const omegaItem = items.find( i => i.id === 16 );
	if ( omegaItem ) {
		measureCartOp( () =>
			http.post( `${ cfg.baseUrl }/wp-json/wc/store/v1/cart/remove-item/`,
				JSON.stringify( { key: omegaItem.key } ),
				{
					headers: { 'Content-Type': 'application/json', Nonce: nonce },
					jar, tags: { name: 'store-api-remove-item' },
				}
			)
		);
	}
	think( 500, 1000 );

	// 9. Add Multivitamin instead
	cartState = measureCartOp( () =>
		storeapi.addToCart( cfg.baseUrl, 26, 1, nonce, jar )
	);
	think( 500, 1000 );

	// 10. Remove coupon
	measureCartOp( () =>
		storeapi.removeCoupon( cfg.baseUrl, 'WELCOME10', nonce, jar )
	);
	think( 300, 800 );

	// 11. Apply BUNDLE15 coupon
	measureCartOp( () =>
		storeapi.applyCoupon( cfg.baseUrl, 'BUNDLE15', nonce, jar )
	);
	think( 500, 1000 );

	// 12. View cart one more time
	http.get( `${ cfg.baseUrl }/cart/`, { jar, tags: { name: 'cart-page' } } );
	measureCartOp( () =>
		storeapi.getCart( cfg.baseUrl, nonce, jar )
	);
	think( 1000, 3000 );

	// 13. View checkout page
	http.get( `${ cfg.baseUrl }/checkout/`, { jar, tags: { name: 'checkout-page' }, redirects: 5 } );
	think( 2000, 4000 );

	// 14. Submit checkout
	const checkoutRes = http.post( `${ cfg.baseUrl }/wp-json/wc/store/v1/checkout/`,
		JSON.stringify( {
			billing_address: {
				first_name: 'Aoife', last_name: 'Murphy',
				address_1: '42 Grafton Street', city: 'Dublin',
				state: 'D', postcode: 'D02 YX88', country: 'IE',
				email: `test+${ Date.now() }${ Math.floor( Math.random() * 9999 ) }@mk.test`,
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
			jar, tags: { name: 'storeapi-checkout' },
		}
	);

	try {
		if ( JSON.parse( checkoutRes.body ).order_id > 0 ) {
			journeySuccess.add( 1 );
			return;
		}
	} catch ( e ) { /* */ }
	journeyFail.add( 1 );
}

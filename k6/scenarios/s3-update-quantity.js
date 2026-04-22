/**
 * S3: Update Cart Item Quantity
 *
 * Adds a product, then updates its quantity from 1 to 3.
 * Classic uses update_order_review + fragments; Store API uses update-item.
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s3-update-quantity.js
 *   k6 run -e MODE=storeapi scenarios/s3-update-quantity.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

export const options = {
	scenarios: {
		update_qty: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
};

const mode = getMode();
const cfg = getConfig();

export default function () {
	if ( mode === 'classic' ) {
		const jar = classic.initSession( cfg.baseUrl );
		classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );

		// Classic update: load cart page, submit the update form
		const cartPage = http.get( `${ cfg.baseUrl }/cart/`, { jar } );
		const nonceMatch = cartPage.body.match(
			/name="woocommerce-cart-nonce"[^>]*value="([^"]+)"/
		);
		const cartNonce = nonceMatch ? nonceMatch[ 1 ] : '';
		const keyMatch = cartPage.body.match(
			/name="cart\[([a-f0-9]+)\]\[qty\]"/
		);
		const cartKey = keyMatch ? keyMatch[ 1 ] : '';

		if ( cartKey && cartNonce ) {
			const updatePayload = {};
			updatePayload[ `cart[${ cartKey }][qty]` ] = '3';
			updatePayload[ 'woocommerce-cart-nonce' ] = cartNonce;
			updatePayload[ 'update_cart' ] = 'Update cart';
			updatePayload[ '_wp_http_referer' ] = '/cart/';

			const res = http.post(
				`${ cfg.baseUrl }/cart/`,
				updatePayload,
				{
					jar,
					tags: { name: 'classic-update-cart' },
					redirects: 0,
				}
			);
			check( res, {
				'update cart 302': ( r ) => r.status === 302,
			} );
		}
	} else {
		const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
		const addRes = storeapi.addToCart(
			cfg.baseUrl, cfg.productId, 1, nonce, jar
		);

		let itemKey = '';
		try {
			itemKey = JSON.parse( addRes.body ).items[ 0 ].key;
		} catch ( e ) {
			return;
		}

		storeapi.updateItem( cfg.baseUrl, itemKey, 3, nonce, jar );
	}
}

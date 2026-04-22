/**
 * S2: View Cart
 *
 * Adds a product first, then measures the cart retrieval endpoint.
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s2-view-cart.js
 *   k6 run -e MODE=storeapi scenarios/s2-view-cart.js
 */

import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

export const options = {
	scenarios: {
		view_cart: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
	thresholds: {
		'http_req_duration{name:wc-ajax-get_refreshed_fragments}': [ 'p(95)<3000' ],
		'http_req_duration{name:store-api-get-cart}': [ 'p(95)<3000' ],
	},
};

const mode = getMode();
const cfg = getConfig();

export function setup() {
	return { mode };
}

export default function () {
	if ( mode === 'classic' ) {
		const jar = classic.initSession( cfg.baseUrl );
		classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
		classic.getCartFragments( cfg.baseUrl, jar );
	} else {
		const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
		storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
		storeapi.getCart( cfg.baseUrl, nonce, jar );
	}
}

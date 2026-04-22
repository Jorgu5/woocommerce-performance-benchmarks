/**
 * S1: Add to Cart
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s1-add-to-cart.js
 *   k6 run -e MODE=storeapi scenarios/s1-add-to-cart.js
 */

import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

export const options = {
	scenarios: {
		add_to_cart: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
	thresholds: {
		'http_req_duration{name:wc-ajax-add_to_cart}': [ 'p(95)<3000' ],
		'http_req_duration{name:store-api-add-item}': [ 'p(95)<3000' ],
	},
};

const mode = getMode();
const cfg = getConfig();

export default function () {
	if ( mode === 'classic' ) {
		const jar = classic.initSession( cfg.baseUrl );
		classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
	} else {
		const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
		storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
	}
}

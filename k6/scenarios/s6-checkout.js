/**
 * S6: Checkout Submit
 *
 * Adds a product, then submits checkout with COD payment.
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s6-checkout.js
 *   k6 run -e MODE=storeapi scenarios/s6-checkout.js
 */

import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

export const options = {
	scenarios: {
		checkout: {
			executor: 'externally-controlled',
			maxVUs: 600,
		},
	},
	thresholds: {
		'http_req_duration{name:wc-ajax-checkout}': [ 'p(95)<5000' ],
		'http_req_duration{name:store-api-checkout}': [ 'p(95)<5000' ],
	},
};

const mode = getMode();
const cfg = getConfig();

export default function () {
	if ( mode === 'classic' ) {
		const jar = classic.initSession( cfg.baseUrl );
		classic.addToCart( cfg.baseUrl, cfg.productId, 1, jar );
		const nonce = classic.getCheckoutNonce( cfg.baseUrl, jar );
		if ( nonce ) {
			classic.checkout( cfg.baseUrl, nonce, jar );
		}
	} else {
		const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
		storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
		storeapi.checkout( cfg.baseUrl, nonce, jar );
	}
}

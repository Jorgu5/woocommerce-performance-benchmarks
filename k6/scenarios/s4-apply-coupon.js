/**
 * S4: Apply Coupon
 *
 * Adds a product, then applies the TEST10 coupon.
 *
 * Usage:
 *   k6 run -e MODE=classic scenarios/s4-apply-coupon.js
 *   k6 run -e MODE=storeapi scenarios/s4-apply-coupon.js
 */

import { getMode, getConfig } from '../config.js';
import * as classic from '../lib/classic.js';
import * as storeapi from '../lib/storeapi.js';

export const options = {
	scenarios: {
		apply_coupon: {
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
		classic.applyCoupon( cfg.baseUrl, cfg.couponCode, jar );
	} else {
		const { jar, nonce } = storeapi.initSession( cfg.baseUrl );
		storeapi.addToCart( cfg.baseUrl, cfg.productId, 1, nonce, jar );
		storeapi.applyCoupon( cfg.baseUrl, cfg.couponCode, nonce, jar );
	}
}

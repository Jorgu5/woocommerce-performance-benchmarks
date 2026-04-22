/**
 * Shared configuration for all k6 test scenarios.
 *
 * Product catalog and weights mirror a real supplements store
 * with ~45% repeat-customer traffic.
 */

export const CONFIG = {
	classic: {
		baseUrl: __ENV.CLASSIC_URL || 'https://classic.example.com',
		productId: parseInt( __ENV.PRODUCT_ID || '15', 10 ),
		couponCode: __ENV.COUPON_CODE || 'TEST10',
	},
	storeapi: {
		baseUrl: __ENV.STOREAPI_URL || 'https://storeapi.example.com',
		productId: parseInt( __ENV.PRODUCT_ID || '15', 10 ),
		couponCode: __ENV.COUPON_CODE || 'TEST10',
	},
};

/**
 * Product catalog weighted by real order-frequency analysis.
 * IDs are identical on both instances (imported from the same XML).
 */
export const PRODUCTS = [
	// Liposomal Magnesium — 45% of orders (TOP SELLER)
	{ id: 23, name: 'Magnesium 100ml', weight: 20, type: 'variation', parentId: 19 },
	{ id: 24, name: 'Magnesium 200ml', weight: 15, type: 'variation', parentId: 19 },
	{ id: 25, name: 'Magnesium 300ml', weight: 10, type: 'variation', parentId: 19 },

	// Liposomal Vitamin C — 17% of orders
	{ id: 21, name: 'Vitamin C Orange', weight: 10, type: 'variation', parentId: 18 },
	{ id: 22, name: 'Vitamin C Berry', weight: 7, type: 'variation', parentId: 18 },

	// Multivitamin — 13% of orders
	{ id: 26, name: 'Multivitamin 1-5', weight: 7, type: 'variation', parentId: 20 },
	{ id: 27, name: 'Multivitamin 6-12', weight: 6, type: 'variation', parentId: 20 },

	// Vegan Omega-3 — 7% of orders (simple)
	{ id: 16, name: 'Omega-3', weight: 7, type: 'simple' },

	// Mighty Magnesium 12+ — 5% of orders (simple)
	{ id: 17, name: 'Magnesium 12+', weight: 5, type: 'simple' },

	// Vitamin D3 & K2 — 4% of orders (simple)
	{ id: 15, name: 'Vitamin D3 K2', weight: 4, type: 'simple' },
];

/**
 * StoreAPI variation IDs (different from classic due to separate import).
 * Map classic variation IDs to storeapi IDs.
 */
// IDs are identical on both Hetzner instances (same import)
export const STOREAPI_VARIATION_MAP = {};

export function getMode() {
	const mode = ( __ENV.MODE || 'classic' ).toLowerCase();
	if ( mode !== 'classic' && mode !== 'storeapi' ) {
		throw new Error( `Invalid MODE "${ mode }". Use "classic" or "storeapi".` );
	}
	return mode;
}

export function getConfig() {
	return CONFIG[ getMode() ];
}

/**
 * Get the correct product ID for the current mode.
 * StoreAPI variations have different IDs than classic.
 */
export function getProductId( product ) {
	if ( getMode() === 'storeapi' && product.type === 'variation' ) {
		return STOREAPI_VARIATION_MAP[ product.id ] || product.id;
	}
	return product.id;
}

/**
 * Realistic customer-behaviour flow helpers.
 *
 * Distribution derived from anonymised production data:
 * - Avg 2.1 items per order
 * - 45% use coupons
 * - Top SKU accounts for 45% of orders (long-tail after that)
 * - Avg order value: €65.58
 * - Top countries: IE (54%), NL (14%), ES (6%), DE (4%)
 * - Payment mix (real): card 80%, iDEAL 10%, PayPal 8% — tested here with COD
 *   to isolate WooCommerce's performance from gateway latency.
 */

/**
 * Weighted random product selection matching real sales distribution.
 *
 * @param {Array} products Array of { id, variationId, weight } objects.
 * @return {object} Selected product.
 */
export function pickProduct( products ) {
	const totalWeight = products.reduce( ( sum, p ) => sum + p.weight, 0 );
	let random = Math.random() * totalWeight;
	for ( const product of products ) {
		random -= product.weight;
		if ( random <= 0 ) {
			return product;
		}
	}
	return products[ products.length - 1 ];
}

/**
 * Decide how many items to add (matching production avg of 2.1).
 *
 * @return {number} Number of items (1-4).
 */
export function pickItemCount() {
	const r = Math.random();
	if ( r < 0.30 ) return 1; // 30% buy 1 item
	if ( r < 0.70 ) return 2; // 40% buy 2 items
	if ( r < 0.90 ) return 3; // 20% buy 3 items
	return 4; // 10% buy 4 items
	// Weighted avg: 0.3*1 + 0.4*2 + 0.2*3 + 0.1*4 = 2.1
}

/**
 * Decide whether to apply a coupon (45% of orders).
 *
 * @return {string|null} Coupon code or null.
 */
export function pickCoupon() {
	if ( Math.random() > 0.45 ) {
		return null;
	}
	const coupons = [ 'WELCOME10', 'BUNDLE15', 'TEST10' ];
	return coupons[ Math.floor( Math.random() * coupons.length ) ];
}

/**
 * Pick a random billing address from top shipping countries.
 *
 * @return {object} Billing address object.
 */
export function pickAddress() {
	const addresses = [
		// Ireland — 54% of orders
		{
			weight: 54,
			first_name: 'Aoife',
			last_name: 'Murphy',
			address_1: '42 Grafton Street',
			city: 'Dublin',
			state: 'D',
			postcode: 'D02 YX88',
			country: 'IE',
			phone: '+353 1 234 5678',
		},
		// Netherlands — 14%
		{
			weight: 14,
			first_name: 'Emma',
			last_name: 'de Vries',
			address_1: 'Keizersgracht 123',
			city: 'Amsterdam',
			state: '',
			postcode: '1015 CJ',
			country: 'NL',
			phone: '+31 20 123 4567',
		},
		// Spain — 6%
		{
			weight: 6,
			first_name: 'Maria',
			last_name: 'Garcia',
			address_1: 'Calle Mayor 15',
			city: 'Madrid',
			state: 'M',
			postcode: '28013',
			country: 'ES',
			phone: '+34 91 234 5678',
		},
		// Germany — 4%
		{
			weight: 4,
			first_name: 'Anna',
			last_name: 'Schmidt',
			address_1: 'Friedrichstraße 43',
			city: 'Berlin',
			state: '',
			postcode: '10117',
			country: 'DE',
			phone: '+49 30 1234567',
		},
		// France — 3%
		{
			weight: 3,
			first_name: 'Sophie',
			last_name: 'Dupont',
			address_1: '15 Rue de Rivoli',
			city: 'Paris',
			state: '',
			postcode: '75001',
			country: 'FR',
			phone: '+33 1 23 45 67 89',
		},
		// UK — 2%
		{
			weight: 2,
			first_name: 'Sarah',
			last_name: 'Wilson',
			address_1: '10 Downing Street',
			city: 'London',
			state: '',
			postcode: 'SW1A 2AA',
			country: 'GB',
			phone: '+44 20 1234 5678',
		},
		// Other EU — remaining
		{
			weight: 17,
			first_name: 'Test',
			last_name: 'Customer',
			address_1: '123 Test Street',
			city: 'Berlin',
			state: '',
			postcode: '10115',
			country: 'DE',
			phone: '+49 30 9876543',
		},
	];

	const totalWeight = addresses.reduce( ( s, a ) => s + a.weight, 0 );
	let random = Math.random() * totalWeight;
	for ( const addr of addresses ) {
		random -= addr.weight;
		if ( random <= 0 ) {
			return {
				...addr,
				email: `test+${ Date.now() }${ Math.floor( Math.random() * 1000 ) }@example.test`,
			};
		}
	}
	return { ...addresses[ 0 ], email: `test+${ Date.now() }@example.test` };
}

/**
 * Simulate realistic think time between actions.
 *
 * Real users spend 5-30s browsing, 10-60s on checkout.
 * For load testing we compress this to 1-5s.
 *
 * @param {string} context Where the user is in the flow.
 * @return {number} Milliseconds to sleep.
 */
export function thinkTime( context ) {
	const ranges = {
		browsing: [ 1000, 3000 ],
		adding: [ 500, 1500 ],
		cart_review: [ 2000, 5000 ],
		filling_form: [ 3000, 8000 ],
		before_submit: [ 1000, 3000 ],
	};
	const [ min, max ] = ranges[ context ] || [ 1000, 3000 ];
	return min + Math.random() * ( max - min );
}

/**
 * Stripe Checkout Performance Test
 *
 * End-to-end checkout flow with real Stripe test payment:
 *   1. Add to cart
 *   2. Navigate to checkout
 *   3. Fill billing fields
 *   4. Fill Stripe card element (test card 4242...)
 *   5. Click Place Order
 *   6. Wait for order confirmation (order-received page)
 *
 * Measures each step individually to compare Classic vs Store API
 * with real payment gateway latency.
 *
 * Requires: Stripe gateway in test mode on both instances.
 *
 * Usage:
 *   node stripe-checkout-test.mjs all
 *   node stripe-checkout-test.mjs classic
 *   node stripe-checkout-test.mjs storeapi
 *
 * Environment:
 *   CLASSIC_URL   (default: https://classic.example.com)
 *   STOREAPI_URL  (default: https://storeapi.example.com)
 *   RUNS          (default: 5)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'stripe-checkout' );
fs.mkdirSync( RESULTS_DIR, { recursive: true } );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const PRODUCT_ID = parseInt( process.env.PRODUCT_ID || '15', 10 );
const RUNS = parseInt( process.env.RUNS || '5', 10 );

async function sleep( ms ) {
	return new Promise( r => setTimeout( r, ms ) );
}

function median( arr ) {
	if ( ! arr.length ) {
		return 0;
	}
	const sorted = [ ...arr ].sort( ( a, b ) => a - b );
	const n = sorted.length;
	return n % 2 ? sorted[ Math.floor( n / 2 ) ] : ( sorted[ n / 2 - 1 ] + sorted[ n / 2 ] ) / 2;
}

/**
 * Fill a Stripe iframe input field.
 *
 * Stripe Elements render card inputs inside iframes. We need to find
 * the correct iframe, get its content frame, and type into it.
 *
 * @param {import('puppeteer').Page} page      Page instance.
 * @param {string}                   selector  Selector for the iframe.
 * @param {string}                   value     Value to type.
 * @param {number}                   delay     Typing delay in ms.
 */
async function typeInStripeFrame( page, selector, value, delay = 50 ) {
	const frameHandle = await page.waitForSelector( selector, { timeout: 15000 } );
	const frame = await frameHandle.contentFrame();
	if ( ! frame ) {
		throw new Error( `Could not get content frame for ${ selector }` );
	}

	const input = await frame.waitForSelector( 'input', { timeout: 5000 } );
	await input.click();
	await input.type( value, { delay } );
}

/**
 * Run a complete checkout with Stripe payment.
 *
 * @param {string} mode 'classic' or 'storeapi'.
 * @return {Object} Timing metrics for each step.
 */
async function runCheckout( mode ) {
	const baseUrl = URLS[ mode ];

	const browser = await puppeteer.launch( {
		headless: 'new',
		args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ],
	} );

	const page = await browser.newPage();
	await page.setViewport( { width: 1366, height: 768 } );

	const steps = {};

	try {
		// 1. Add to cart
		const addStart = Date.now();
		await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

		if ( mode === 'classic' ) {
			await page.evaluate( async ( productId ) => {
				const f = new FormData();
				f.append( 'product_id', productId );
				f.append( 'quantity', '2' );
				await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: f } );
			}, PRODUCT_ID );
		} else {
			await page.evaluate( async ( productId ) => {
				await fetch( '/wp-json/wc/store/v1/cart/add-item/', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify( { id: productId, quantity: 2 } ),
				} );
			}, PRODUCT_ID );
		}
		steps.addToCart = Date.now() - addStart;

		// 2. Navigate to checkout
		const checkoutStart = Date.now();
		await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
		steps.pageLoad = Date.now() - checkoutStart;

		// 3. Wait for form to be interactive
		const ttiStart = Date.now();
		if ( mode === 'classic' ) {
			await page.waitForSelector( '#billing_first_name', { timeout: 15000 } );
		} else {
			await page.waitForSelector(
				'input[id*="email"], .wc-block-components-text-input input',
				{ timeout: 15000 }
			);
			await sleep( 1500 ); // React hydration + Stripe mount
		}
		steps.timeToInteractive = Date.now() - ttiStart;

		// 4. Fill billing fields
		const fillStart = Date.now();
		const fields = mode === 'classic'
			? [
				[ '#billing_first_name', 'Max' ],
				[ '#billing_last_name', 'Mustermann' ],
				[ '#billing_address_1', 'Friedrichstr. 123' ],
				[ '#billing_city', 'Berlin' ],
				[ '#billing_postcode', '10115' ],
				[ '#billing_phone', '+4930123456' ],
				[ '#billing_email', `stripe+${ Date.now() }@mk.test` ],
			]
			: [
				[ '#email, input[id*="email"]', `stripe+${ Date.now() }@mk.test` ],
				[ '#billing-first_name, input[id*="first_name"], input[id*="first-name"]', 'Max' ],
				[ '#billing-last_name, input[id*="last_name"], input[id*="last-name"]', 'Mustermann' ],
				[ '#billing-address_1, input[id*="address_1"], input[id*="address-1"]', 'Friedrichstr. 123' ],
				[ '#billing-city, input[id*="city"]', 'Berlin' ],
				[ '#billing-postcode, input[id*="postcode"]', '10115' ],
				[ '#billing-phone, input[id*="phone"]', '+4930123456' ],
			];

		for ( const [ selector, value ] of fields ) {
			try {
				const el = await page.$( selector );
				if ( el ) {
					await el.click( { clickCount: 3 } );
					await el.type( value, { delay: 20 } );
					await page.keyboard.press( 'Tab' );
					await sleep( 200 );
				}
			} catch ( e ) {
				// Field not found
			}
		}
		steps.fillBilling = Date.now() - fillStart;

		// 5. Wait for order totals to update
		const updateStart = Date.now();
		if ( mode === 'classic' ) {
			await sleep( 2000 );
			await page.waitForFunction(
				() => ! document.querySelector( '.blockOverlay' ),
				{ timeout: 10000 }
			).catch( () => {} );
		} else {
			await sleep( 1000 );
			await page.waitForFunction(
				() => ! document.querySelector( '.wc-block-components-loading-mask' ),
				{ timeout: 10000 }
			).catch( () => {} );
		}
		steps.updateWait = Date.now() - updateStart;

		// 5b. Select Stripe payment method
		if ( mode === 'classic' ) {
			const stripeRadio = await page.$( '#payment_method_stripe' );
			if ( stripeRadio ) {
				await stripeRadio.click();
				await sleep( 1500 );
			}
		} else {
			// Block checkout: click the Stripe radio/tab
			const stripeOption = await page.$(
				'input[value="stripe"], label[for*="stripe"], .wc-block-components-radio-control__input[value="stripe"]'
			);
			if ( stripeOption ) {
				await stripeOption.click();
				await sleep( 1500 );
			}
		}

		// 6. Fill Stripe card element
		const stripeStart = Date.now();

		// Stripe Payment Element renders card inputs inside an iframe
		// with src containing "elements-inner-accessory-target".
		// The inputs use name="number", name="expiry", name="cvc".
		//
		// Detection strategy: find the iframe by src pattern via the page
		// DOM, then get its contentFrame from Puppeteer.
		try {
			// Wait for Stripe iframes to mount
			await page.waitForSelector( 'iframe[src*="elements-inner-accessory-target"]', { timeout: 15000 } );
			await sleep( 2000 );

			// Get all matching iframes and find the visible one with card inputs
			const stripeFrames = await page.$$( 'iframe[src*="elements-inner-accessory-target"]' );
			let cardFilled = false;

			for ( const handle of stripeFrames ) {
				// Check if this iframe is visible (not the hidden express checkout one)
				const box = await handle.boundingBox();
				if ( ! box || box.height < 20 ) {
					continue;
				}

				const frame = await handle.contentFrame();
				if ( ! frame ) {
					continue;
				}

				const cardInput = await frame.$( 'input[name="number"]' );
				if ( ! cardInput ) {
					continue;
				}

				await cardInput.click();
				await cardInput.type( '4242424242424242', { delay: 15 } );

				const expInput = await frame.$( 'input[name="expiry"]' );
				if ( expInput ) {
					await expInput.click();
					await expInput.type( '1230', { delay: 15 } );
				}

				const cvcInput = await frame.$( 'input[name="cvc"]' );
				if ( cvcInput ) {
					await cvcInput.click();
					await cvcInput.type( '123', { delay: 15 } );
				}

				cardFilled = true;
				break;
			}

			if ( ! cardFilled ) {
				console.log( '    WARNING: Could not fill Stripe card' );
			}
		} catch ( e ) {
			console.log( `    Stripe fill error: ${ e.message }` );
		}

		steps.fillStripe = Date.now() - stripeStart;

		// 7. Place order
		// Stripe's payment flow is async: click → Stripe API call → WC AJAX → redirect.
		// waitForNavigation can miss the redirect if it fires before Stripe is done.
		// Instead, poll for the order-received URL.
		const submitStart = Date.now();

		let placeOrderSelector;
		if ( mode === 'classic' ) {
			placeOrderSelector = '#place_order';
		} else {
			placeOrderSelector = '.wc-block-components-checkout-place-order-button, button.wc-block-components-button';
		}

		const placeBtn = await page.$( placeOrderSelector );
		if ( placeBtn ) {
			await placeBtn.click();

			// Wait for order-received page or WC error (up to 45s)
			await page.waitForFunction(
				() => window.location.href.includes( 'order-received' ) ||
					document.querySelector( '.woocommerce-error' ),
				{ timeout: 45000 }
			).catch( () => {} );
		}

		steps.submitToConfirmation = Date.now() - submitStart;

		// Check success
		steps.success = page.url().includes( 'order-received' );
		steps.finalUrl = page.url();

		// Take screenshot for debugging
		await page.screenshot( {
			path: path.join( RESULTS_DIR, `${ mode }-${ Date.now() }.png` ),
			fullPage: false,
		} );

		steps.totalCheckout = steps.pageLoad + steps.timeToInteractive +
			steps.fillBilling + steps.updateWait + steps.fillStripe + steps.submitToConfirmation;

	} catch ( error ) {
		steps.error = error.message;
		steps.success = false;

		await page.screenshot( {
			path: path.join( RESULTS_DIR, `${ mode }-error-${ Date.now() }.png` ),
			fullPage: true,
		} ).catch( () => {} );
	} finally {
		await browser.close();
	}

	return steps;
}

/**
 * Run all tests for a given mode.
 *
 * @param {string} mode 'classic' or 'storeapi'.
 * @return {Object} { mode, results }
 */
async function runMode( mode ) {
	console.log( `\n${ '═'.repeat( 70 ) }` );
	console.log( `  ${ mode.toUpperCase() } — Stripe Checkout (${ RUNS } runs)` );
	console.log( `${ '═'.repeat( 70 ) }` );

	const results = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }:` );
		const r = await runCheckout( mode );

		if ( r.error ) {
			console.log( `    ERROR: ${ r.error }` );
		} else {
			console.log(
				`    Page load: ${ r.pageLoad }ms` +
				`  TTI: ${ r.timeToInteractive }ms` +
				`  Billing: ${ r.fillBilling }ms` +
				`  Update: ${ r.updateWait }ms` +
				`  Stripe: ${ r.fillStripe }ms` +
				`  Submit→Confirm: ${ r.submitToConfirmation }ms` +
				`  ${ r.success ? '✓' : '✗' }` +
				`  Total: ${ r.totalCheckout }ms`
			);
		}

		results.push( r );
	}

	// Summary
	const valid = results.filter( r => ! r.error );
	const successful = valid.filter( r => r.success );

	if ( valid.length ) {
		const metricKeys = [
			[ 'Page load', 'pageLoad' ],
			[ 'Time to interactive', 'timeToInteractive' ],
			[ 'Fill billing', 'fillBilling' ],
			[ 'Update wait', 'updateWait' ],
			[ 'Fill Stripe', 'fillStripe' ],
			[ 'Submit → Confirm', 'submitToConfirmation' ],
			[ 'Total checkout', 'totalCheckout' ],
		];

		console.log( `\n  ${ '─'.repeat( 50 ) }` );
		console.log( `  SUMMARY (${ successful.length }/${ valid.length } successful)` );

		for ( const [ label, key ] of metricKeys ) {
			const vals = valid.map( r => r[ key ] ).filter( v => v !== undefined );
			console.log( `    ${ label.padEnd( 22 ) } ${ median( vals ) }ms` );
		}
	}

	// Save
	fs.writeFileSync(
		path.join( RESULTS_DIR, `${ mode }-stripe-${ Date.now() }.json` ),
		JSON.stringify( { mode, runs: RUNS, results }, null, 2 )
	);

	return { mode, results: valid, successful: successful.length };
}

/**
 * Print comparison between classic and storeapi.
 */
function printComparison( classicData, storeapiData ) {
	console.log( `\n${ '═'.repeat( 80 ) }` );
	console.log( '  STRIPE CHECKOUT — COMPARISON' );
	console.log( `${ '═'.repeat( 80 ) }` );

	const metricKeys = [
		[ 'Page load', 'pageLoad', 'ms' ],
		[ 'Time to interactive', 'timeToInteractive', 'ms' ],
		[ 'Fill billing', 'fillBilling', 'ms' ],
		[ 'Update wait', 'updateWait', 'ms' ],
		[ 'Fill Stripe card', 'fillStripe', 'ms' ],
		[ 'Submit → Confirm', 'submitToConfirmation', 'ms' ],
		[ 'Total checkout', 'totalCheckout', 'ms' ],
	];

	console.log(
		`\n  ${ 'Step'.padEnd( 24 ) }` +
		` │ ${ 'Classic'.padStart( 10 ) }` +
		` │ ${ 'Store API'.padStart( 10 ) }` +
		` │ ${ 'Diff'.padStart( 10 ) }`
	);
	console.log( `  ${ '─'.repeat( 24 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

	for ( const [ label, key, unit ] of metricKeys ) {
		const cVals = classicData.results.map( r => r[ key ] ).filter( v => v !== undefined );
		const sVals = storeapiData.results.map( r => r[ key ] ).filter( v => v !== undefined );

		const cMed = median( cVals );
		const sMed = median( sVals );
		const diff = cMed > 0 ? ( ( sMed - cMed ) / cMed * 100 ).toFixed( 1 ) + '%' : '—';

		console.log(
			`  ${ label.padEnd( 24 ) }` +
			` │ ${ ( Math.round( cMed ) + unit ).padStart( 10 ) }` +
			` │ ${ ( Math.round( sMed ) + unit ).padStart( 10 ) }` +
			` │ ${ diff.padStart( 10 ) }`
		);
	}

	console.log( `\n  Success rate: Classic ${ classicData.successful }/${ classicData.results.length }  Store API ${ storeapiData.successful }/${ storeapiData.results.length }` );
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice( 2 );
const mode = args[ 0 ] || 'all';

( async () => {
	if ( mode === 'all' ) {
		const classicData = await runMode( 'classic' );
		const storeapiData = await runMode( 'storeapi' );
		printComparison( classicData, storeapiData );
	} else {
		await runMode( mode );
	}
} )();

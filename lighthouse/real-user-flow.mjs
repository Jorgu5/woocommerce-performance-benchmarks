/**
 * Real User Flow Benchmark
 *
 * Simulates an actual user completing the full checkout:
 * 1. Visit shop page
 * 2. Click "Add to cart" on a product
 * 3. Navigate to cart page
 * 4. Proceed to checkout
 * 5. Fill all billing fields
 * 6. Select shipping method
 * 7. Select payment method
 * 8. Place order
 *
 * Measures total time from shop page load to order confirmation.
 * This captures what synthetic API benchmarks miss:
 * - Client-side rendering time
 * - Number of server roundtrips
 * - Form interaction speed
 * - React vs jQuery field handling
 *
 * Usage:
 *   node real-user-flow.mjs classic    # Test classic checkout
 *   node real-user-flow.mjs storeapi   # Test Store API checkout
 *   node real-user-flow.mjs all        # Both, 5 runs each
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'real-user-flow' );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const RUNS = parseInt( process.env.RUNS || '5', 10 );

const BILLING = {
	first_name: 'k6',
	last_name: 'TestUser',
	address_1: '123 Test Street',
	city: 'Berlin',
	postcode: '10115',
	phone: '01234567890',
	email: `k6test+${ Date.now() }@example.com`,
};

async function sleep( ms ) {
	return new Promise( ( r ) => setTimeout( r, ms ) );
}

async function measureStep( name, fn ) {
	const start = Date.now();
	await fn();
	const duration = Date.now() - start;
	return { name, duration };
}

async function runClassicFlow( baseUrl, runNum ) {
	const browser = await puppeteer.launch( {
		headless: 'new',
		args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ],
	} );
	const page = await browser.newPage();
	await page.setViewport( { width: 1366, height: 768 } );

	const steps = [];
	const totalStart = Date.now();

	try {
		// Step 1: Visit shop
		steps.push( await measureStep( 'Shop page load', async () => {
			await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );
		} ) );

		// Step 2: Add to cart (via AJAX button)
		steps.push( await measureStep( 'Add to cart', async () => {
			// Find first "Add to cart" button
			const addBtn = await page.$( '.add_to_cart_button, .ajax_add_to_cart' );
			if ( addBtn ) {
				await addBtn.click();
				// Wait for the "View cart" button to appear (AJAX complete)
				await page.waitForSelector( '.added_to_cart, .wc-forward', {
					timeout: 10000,
				} ).catch( () => {} );
			} else {
				// Fallback: add via URL
				await page.evaluate( async () => {
					const form = new FormData();
					form.append( 'product_id', '85' );
					form.append( 'quantity', '1' );
					await fetch( '/?wc-ajax=add_to_cart', {
						method: 'POST',
						body: form,
					} );
				} );
			}
			await sleep( 500 );
		} ) );

		// Step 3: Navigate to cart
		steps.push( await measureStep( 'Cart page load', async () => {
			await page.goto( `${ baseUrl }/cart/`, { waitUntil: 'networkidle2' } );
		} ) );

		// Step 4: Navigate to checkout
		steps.push( await measureStep( 'Checkout page load', async () => {
			await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
		} ) );

		// Step 5: Fill billing fields
		steps.push( await measureStep( 'Fill billing fields', async () => {
			// Classic checkout uses standard form fields
			await page.waitForSelector( '#billing_first_name', { timeout: 10000 } )
				.catch( () => {} );

			const fields = {
				'#billing_first_name': BILLING.first_name,
				'#billing_last_name': BILLING.last_name,
				'#billing_address_1': BILLING.address_1,
				'#billing_city': BILLING.city,
				'#billing_postcode': BILLING.postcode,
				'#billing_phone': BILLING.phone,
				'#billing_email': BILLING.email,
			};

			for ( const [ selector, value ] of Object.entries( fields ) ) {
				const el = await page.$( selector );
				if ( el ) {
					await el.click( { clickCount: 3 } );
					await el.type( value, { delay: 20 } );
				}
			}

			// Country should default to DE
			// Wait for shipping to update after address filled
			await sleep( 2000 );
		} ) );

		// Step 6: Wait for order review to update (AJAX roundtrip)
		steps.push( await measureStep( 'Order review update', async () => {
			await page.waitForFunction(
				() => ! document.querySelector( '.blockOverlay' ),
				{ timeout: 10000 }
			).catch( () => {} );
		} ) );

		// Step 7: Select COD payment (should be default)
		steps.push( await measureStep( 'Select payment', async () => {
			const cod = await page.$( '#payment_method_cod' );
			if ( cod ) {
				await cod.click();
				await sleep( 500 );
			}
		} ) );

		// Step 8: Place order
		steps.push( await measureStep( 'Place order + redirect', async () => {
			const placeBtn = await page.$( '#place_order' );
			if ( placeBtn ) {
				await Promise.all( [
					page.waitForNavigation( { waitUntil: 'networkidle2', timeout: 30000 } ),
					placeBtn.click(),
				] );
			}
		} ) );

		// Check success
		const url = page.url();
		const isSuccess = url.includes( 'order-received' );

		const totalDuration = Date.now() - totalStart;

		steps.push( { name: 'TOTAL', duration: totalDuration } );

		return { steps, success: isSuccess, url };
	} catch ( error ) {
		return { steps, success: false, error: error.message };
	} finally {
		await browser.close();
	}
}

async function runStoreApiFlow( baseUrl, runNum ) {
	const browser = await puppeteer.launch( {
		headless: 'new',
		args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ],
	} );
	const page = await browser.newPage();
	await page.setViewport( { width: 1366, height: 768 } );

	const steps = [];
	const totalStart = Date.now();

	try {
		// Step 1: Visit shop
		steps.push( await measureStep( 'Shop page load', async () => {
			await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );
		} ) );

		// Step 2: Add to cart
		steps.push( await measureStep( 'Add to cart', async () => {
			const addBtn = await page.$( '.add_to_cart_button, .ajax_add_to_cart, .wp-block-button__link' );
			if ( addBtn ) {
				await addBtn.click();
				await sleep( 2000 ); // Wait for Store API response
			} else {
				await page.evaluate( async () => {
					await fetch( '/wp-json/wc/store/v1/cart/add-item/', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify( { id: 85, quantity: 1 } ),
					} );
				} );
			}
		} ) );

		// Step 3: Navigate to cart
		steps.push( await measureStep( 'Cart page load', async () => {
			await page.goto( `${ baseUrl }/cart/`, { waitUntil: 'networkidle2' } );
		} ) );

		// Step 4: Navigate to checkout
		steps.push( await measureStep( 'Checkout page load', async () => {
			await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
		} ) );

		// Step 5: Fill billing fields (Block checkout uses different selectors)
		steps.push( await measureStep( 'Fill billing fields', async () => {
			// Block checkout uses wc-block-components-text-input
			// Wait for the checkout form to render
			await page.waitForSelector(
				'#email, input[id*="email"], .wc-block-components-text-input input',
				{ timeout: 15000 }
			).catch( () => {} );

			// Give React time to mount
			await sleep( 1000 );

			// Try block checkout field selectors
			const fieldMappings = [
				[ '#email', BILLING.email ],
				[ '#billing-first_name, input[id*="first_name"], input[id*="first-name"]', BILLING.first_name ],
				[ '#billing-last_name, input[id*="last_name"], input[id*="last-name"]', BILLING.last_name ],
				[ '#billing-address_1, input[id*="address_1"], input[id*="address-1"]', BILLING.address_1 ],
				[ '#billing-city, input[id*="city"]', BILLING.city ],
				[ '#billing-postcode, input[id*="postcode"]', BILLING.postcode ],
				[ '#billing-phone, input[id*="phone"]', BILLING.phone ],
			];

			for ( const [ selector, value ] of fieldMappings ) {
				try {
					const el = await page.$( selector );
					if ( el ) {
						await el.click( { clickCount: 3 } );
						await el.type( value, { delay: 20 } );
						// Tab out to trigger React onChange
						await page.keyboard.press( 'Tab' );
					}
				} catch ( e ) {
					// Field not found, continue
				}
			}

			await sleep( 1000 );
		} ) );

		// Step 6: Wait for totals to update
		steps.push( await measureStep( 'Totals update', async () => {
			// Block checkout updates reactively — wait for loading to finish
			await page.waitForFunction(
				() => ! document.querySelector( '.wc-block-components-loading-mask' ),
				{ timeout: 10000 }
			).catch( () => {} );
			await sleep( 500 );
		} ) );

		// Step 7: Select COD payment
		steps.push( await measureStep( 'Select payment', async () => {
			const codRadio = await page.$(
				'input[value="cod"], label[for*="cod"], .wc-block-components-radio-control__input[value="cod"]'
			);
			if ( codRadio ) {
				await codRadio.click();
				await sleep( 500 );
			}
		} ) );

		// Step 8: Place order
		steps.push( await measureStep( 'Place order + redirect', async () => {
			const placeBtn = await page.$(
				'.wc-block-components-checkout-place-order-button, button[type="submit"].wc-block-components-button'
			);
			if ( placeBtn ) {
				await Promise.all( [
					page.waitForNavigation( {
						waitUntil: 'networkidle2',
						timeout: 30000,
					} ).catch( () => {} ),
					placeBtn.click(),
				] );
			}
		} ) );

		const url = page.url();
		const isSuccess = url.includes( 'order-received' );
		const totalDuration = Date.now() - totalStart;

		steps.push( { name: 'TOTAL', duration: totalDuration } );

		return { steps, success: isSuccess, url };
	} catch ( error ) {
		return { steps, success: false, error: error.message };
	} finally {
		await browser.close();
	}
}

async function runBenchmark( mode ) {
	const baseUrl = URLS[ mode ];
	const flowFn = mode === 'classic' ? runClassicFlow : runStoreApiFlow;

	fs.mkdirSync( RESULTS_DIR, { recursive: true } );

	console.log( `\n${ '═'.repeat( 70 ) }` );
	console.log( `  ${ mode.toUpperCase() } — Real User Checkout Flow (${ RUNS } runs)` );
	console.log( `  URL: ${ baseUrl }` );
	console.log( `${ '═'.repeat( 70 ) }` );

	const allResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }:` );
		const result = await flowFn( baseUrl, run );

		for ( const step of result.steps ) {
			const bar = '█'.repeat( Math.min( Math.round( step.duration / 100 ), 40 ) );
			console.log(
				`    ${ step.name.padEnd( 25 ) } ${ String( step.duration ).padStart( 6 ) }ms  ${ bar }`
			);
		}
		console.log( `    Success: ${ result.success ? '✓' : '✗' } ${ result.error || '' }` );

		allResults.push( result );
	}

	// Summary
	const totals = allResults
		.filter( ( r ) => r.success )
		.map( ( r ) => r.steps.find( ( s ) => s.name === 'TOTAL' )?.duration || 0 )
		.filter( ( t ) => t > 0 );

	if ( totals.length > 0 ) {
		totals.sort( ( a, b ) => a - b );
		const median = totals[ Math.floor( totals.length / 2 ) ];
		const avg = Math.round( totals.reduce( ( a, b ) => a + b, 0 ) / totals.length );
		const min = totals[ 0 ];
		const max = totals[ totals.length - 1 ];

		console.log( `\n  ${ '─'.repeat( 50 ) }` );
		console.log( `  TOTAL (shop → order confirmed)` );
		console.log( `    Median: ${ median }ms  Avg: ${ avg }ms  Min: ${ min }ms  Max: ${ max }ms` );
		console.log(
			`    Success: ${ allResults.filter( ( r ) => r.success ).length }/${ RUNS }`
		);

		return { mode, median, avg, min, max, totals, success: allResults.filter( ( r ) => r.success ).length };
	}

	return { mode, median: 0, avg: 0, min: 0, max: 0, totals: [], success: 0 };
}

// Main
const args = process.argv.slice( 2 );
const mode = args[ 0 ] || 'all';

( async () => {
	const results = {};

	if ( mode === 'all' ) {
		results.classic = await runBenchmark( 'classic' );
		results.storeapi = await runBenchmark( 'storeapi' );

		console.log( `\n${ '═'.repeat( 70 ) }` );
		console.log( '  COMPARISON: Full Checkout Flow (shop → order confirmed)' );
		console.log( `${ '═'.repeat( 70 ) }` );
		console.log(
			`  ${ 'Metric'.padEnd( 12 ) } ${ 'Classic'.padStart( 10 ) } ${ 'Store API'.padStart( 10 ) } ${ 'Diff'.padStart( 10 ) } ${ 'Winner'.padStart( 10 ) }`
		);
		console.log( `  ${ '─'.repeat( 55 ) }` );

		for ( const metric of [ 'median', 'avg', 'min', 'max' ] ) {
			const c = results.classic[ metric ];
			const s = results.storeapi[ metric ];
			const diff = c > 0 ? ( ( ( s - c ) / c ) * 100 ).toFixed( 1 ) : '—';
			const winner = s < c ? 'Store API' : 'Classic';
			console.log(
				`  ${ metric.padEnd( 12 ) } ${ ( c + 'ms' ).padStart( 10 ) } ${ ( s + 'ms' ).padStart( 10 ) } ${ ( diff + '%' ).padStart( 10 ) } ${ winner.padStart( 10 ) }`
			);
		}
		console.log(
			`  ${ 'Success'.padEnd( 12 ) } ${ ( results.classic.success + '/' + RUNS ).padStart( 10 ) } ${ ( results.storeapi.success + '/' + RUNS ).padStart( 10 ) }`
		);
	} else {
		await runBenchmark( mode );
	}

	// Save results
	fs.writeFileSync(
		path.join( RESULTS_DIR, `results-${ Date.now() }.json` ),
		JSON.stringify( results, null, 2 )
	);
} )();

/**
 * Checkout Interaction Test
 *
 * Measures what happens AFTER the checkout page loads:
 * - Fill billing fields (time per field)
 * - Trigger shipping recalculation (classic = AJAX, storeapi = client-side)
 * - Count server roundtrips during form fill
 * - Measure total time from "page loaded" to "ready to submit"
 *
 * This is Store API's key advantage: fewer server calls during interaction.
 *
 * Usage:
 *   node checkout-interaction-test.mjs classic
 *   node checkout-interaction-test.mjs storeapi
 *   node checkout-interaction-test.mjs all
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'interaction-test' );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const RUNS = parseInt( process.env.RUNS || '5', 10 );

async function sleep( ms ) {
	return new Promise( r => setTimeout( r, ms ) );
}

async function runInteractionTest( mode ) {
	const baseUrl = URLS[ mode ];
	fs.mkdirSync( RESULTS_DIR, { recursive: true } );

	console.log( `\n${ '═'.repeat( 70 ) }` );
	console.log( `  ${ mode.toUpperCase() } — Checkout Interaction Test (${ RUNS } runs)` );
	console.log( `${ '═'.repeat( 70 ) }` );

	const allResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }:` );

		const browser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ],
		} );

		const page = await browser.newPage();
		await page.setViewport( { width: 1366, height: 768 } );

		// Track all network requests
		const networkRequests = [];
		page.on( 'request', req => {
			if ( req.resourceType() === 'xhr' || req.resourceType() === 'fetch' ) {
				networkRequests.push( {
					url: req.url(),
					method: req.method(),
					time: Date.now(),
					type: req.resourceType(),
				} );
			}
		} );

		try {
			// 1. Add item to cart
			await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

			if ( mode === 'classic' ) {
				await page.evaluate( async () => {
					const form = new FormData();
					form.append( 'product_id', '15' );
					form.append( 'quantity', '2' );
					await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: form } );
				} );
			} else {
				await page.evaluate( async () => {
					await fetch( '/wp-json/wc/store/v1/cart/add-item/', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify( { id: 15, quantity: 2 } ),
					} );
				} );
			}

			await sleep( 500 );

			// 2. Navigate to checkout
			const checkoutLoadStart = Date.now();
			await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
			const checkoutLoadTime = Date.now() - checkoutLoadStart;
			console.log( `    Checkout page load: ${ checkoutLoadTime }ms` );

			// 3. Wait for checkout form to be interactive
			const interactiveStart = Date.now();

			if ( mode === 'classic' ) {
				await page.waitForSelector( '#billing_first_name', { timeout: 15000 } ).catch( () => {} );
			} else {
				await page.waitForSelector(
					'input[id*="email"], .wc-block-components-text-input input',
					{ timeout: 15000 }
				).catch( () => {} );
				await sleep( 1000 ); // Wait for React hydration
			}

			const timeToInteractive = Date.now() - interactiveStart;
			console.log( `    Time to interactive: ${ timeToInteractive }ms` );

			// Reset network tracking for interaction phase
			const preInteractionRequests = networkRequests.length;

			// 4. Fill billing fields and measure each
			const interactionStart = Date.now();
			const fieldTimings = [];

			const fields = mode === 'classic'
				? [
					[ '#billing_first_name', 'Aoife' ],
					[ '#billing_last_name', 'Murphy' ],
					[ '#billing_address_1', '42 Grafton Street' ],
					[ '#billing_city', 'Dublin' ],
					[ '#billing_postcode', 'D02 YX88' ],
					[ '#billing_phone', '+35312345678' ],
					[ '#billing_email', `test+${ Date.now() }@mk.test` ],
				]
				: [
					[ '#email, input[id*="email"]', `test+${ Date.now() }@mk.test` ],
					[ '#billing-first_name, input[id*="first_name"], input[id*="first-name"]', 'Aoife' ],
					[ '#billing-last_name, input[id*="last_name"], input[id*="last-name"]', 'Murphy' ],
					[ '#billing-address_1, input[id*="address_1"], input[id*="address-1"]', '42 Grafton Street' ],
					[ '#billing-city, input[id*="city"]', 'Dublin' ],
					[ '#billing-postcode, input[id*="postcode"]', 'D02 YX88' ],
					[ '#billing-phone, input[id*="phone"]', '+35312345678' ],
				];

			for ( const [ selector, value ] of fields ) {
				const fieldStart = Date.now();
				try {
					const el = await page.$( selector );
					if ( el ) {
						await el.click( { clickCount: 3 } );
						await el.type( value, { delay: 30 } );
						await page.keyboard.press( 'Tab' );
						await sleep( 300 ); // Let any AJAX fire
					}
				} catch ( e ) {
					// Field not found
				}
				fieldTimings.push( Date.now() - fieldStart );
			}

			// 5. Wait for any pending updates (shipping recalc, order review)
			const updateWaitStart = Date.now();

			if ( mode === 'classic' ) {
				// Classic fires update_order_review AJAX after address changes
				await sleep( 2000 );
				await page.waitForFunction(
					() => ! document.querySelector( '.blockOverlay' ),
					{ timeout: 10000 }
				).catch( () => {} );
			} else {
				// Store API updates reactively
				await sleep( 1000 );
				await page.waitForFunction(
					() => ! document.querySelector( '.wc-block-components-loading-mask' ),
					{ timeout: 10000 }
				).catch( () => {} );
			}

			const updateWaitTime = Date.now() - updateWaitStart;
			const totalInteractionTime = Date.now() - interactionStart;

			// 6. Count server requests during interaction
			const interactionRequests = networkRequests.slice( preInteractionRequests );
			const ajaxCalls = interactionRequests.filter( r =>
				r.url.includes( 'wc-ajax' ) ||
				r.url.includes( 'wp-json' ) ||
				r.url.includes( 'admin-ajax' )
			);

			console.log( `    Field fill time: ${ fieldTimings.reduce( ( a, b ) => a + b, 0 ) }ms` );
			console.log( `    Update wait: ${ updateWaitTime }ms` );
			console.log( `    Total interaction: ${ totalInteractionTime }ms` );
			console.log( `    Server calls during fill: ${ ajaxCalls.length }` );
			console.log( `    AJAX URLs: ${ ajaxCalls.map( r => new URL( r.url ).pathname ).join( ', ' ) || 'none' }` );

			const result = {
				checkoutLoadTime,
				timeToInteractive,
				fieldFillTime: fieldTimings.reduce( ( a, b ) => a + b, 0 ),
				updateWaitTime,
				totalInteractionTime,
				serverCallsDuringFill: ajaxCalls.length,
				ajaxUrls: ajaxCalls.map( r => r.url ),
				fieldTimings,
			};

			allResults.push( result );
		} catch ( error ) {
			console.log( `    Error: ${ error.message }` );
			allResults.push( { error: error.message } );
		} finally {
			await browser.close();
		}
	}

	// Summary
	const valid = allResults.filter( r => ! r.error );
	if ( valid.length > 0 ) {
		const med = arr => {
			const s = [ ...arr ].sort( ( a, b ) => a - b );
			return s[ Math.floor( s.length / 2 ) ];
		};

		console.log( `\n  ${ '─'.repeat( 50 ) }` );
		console.log( `  SUMMARY (${ valid.length } successful runs)` );
		console.log( `    Checkout load:     ${ med( valid.map( r => r.checkoutLoadTime ) ) }ms` );
		console.log( `    Time to interactive: ${ med( valid.map( r => r.timeToInteractive ) ) }ms` );
		console.log( `    Field fill:        ${ med( valid.map( r => r.fieldFillTime ) ) }ms` );
		console.log( `    Update wait:       ${ med( valid.map( r => r.updateWaitTime ) ) }ms` );
		console.log( `    Total interaction: ${ med( valid.map( r => r.totalInteractionTime ) ) }ms` );
		console.log( `    Server calls:      ${ med( valid.map( r => r.serverCallsDuringFill ) ) }` );
	}

	// Save
	fs.writeFileSync(
		path.join( RESULTS_DIR, `${ mode }-interaction-${ Date.now() }.json` ),
		JSON.stringify( { mode, runs: RUNS, results: allResults }, null, 2 )
	);

	return { mode, results: valid };
}

async function runReturningVisitorTest( mode ) {
	const baseUrl = URLS[ mode ];

	console.log( `\n${ '═'.repeat( 70 ) }` );
	console.log( `  ${ mode.toUpperCase() } — Returning Visitor Test (${ RUNS } runs)` );
	console.log( `${ '═'.repeat( 70 ) }` );

	const allResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }:` );

		const browser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu' ],
		} );

		const page = await browser.newPage();

		try {
			// Add item to cart
			await page.goto( `${ baseUrl }/`, { waitUntil: 'networkidle2' } );

			if ( mode === 'classic' ) {
				await page.evaluate( async () => {
					const form = new FormData();
					form.append( 'product_id', '15' );
					form.append( 'quantity', '1' );
					await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: form } );
				} );
			} else {
				await page.evaluate( async () => {
					await fetch( '/wp-json/wc/store/v1/cart/add-item/', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify( { id: 15, quantity: 1 } ),
					} );
				} );
			}

			// First visit (cold cache)
			const coldStart = Date.now();
			await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
			const coldTime = Date.now() - coldStart;

			// Second visit (warm browser cache)
			const warmStart = Date.now();
			await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
			const warmTime = Date.now() - warmStart;

			const improvement = ( ( coldTime - warmTime ) / coldTime * 100 ).toFixed( 1 );

			console.log( `    Cold: ${ coldTime }ms  Warm: ${ warmTime }ms  Improvement: ${ improvement }%` );

			allResults.push( { coldTime, warmTime, improvement: parseFloat( improvement ) } );
		} catch ( error ) {
			console.log( `    Error: ${ error.message }` );
		} finally {
			await browser.close();
		}
	}

	const valid = allResults.filter( r => r.coldTime );
	if ( valid.length > 0 ) {
		const med = arr => {
			const s = [ ...arr ].sort( ( a, b ) => a - b );
			return s[ Math.floor( s.length / 2 ) ];
		};
		console.log( `\n  SUMMARY` );
		console.log( `    Cold load:  ${ med( valid.map( r => r.coldTime ) ) }ms` );
		console.log( `    Warm load:  ${ med( valid.map( r => r.warmTime ) ) }ms` );
		console.log( `    Cache benefit: ${ med( valid.map( r => r.improvement ) ) }%` );
	}

	fs.writeFileSync(
		path.join( RESULTS_DIR, `${ mode }-returning-${ Date.now() }.json` ),
		JSON.stringify( { mode, results: allResults }, null, 2 )
	);

	return { mode, results: valid };
}

// Main
const args = process.argv.slice( 2 );
const mode = args[ 0 ] || 'all';

( async () => {
	if ( mode === 'all' ) {
		// Interaction tests
		const classicInt = await runInteractionTest( 'classic' );
		const storeapiInt = await runInteractionTest( 'storeapi' );

		// Returning visitor tests
		const classicRet = await runReturningVisitorTest( 'classic' );
		const storeapiRet = await runReturningVisitorTest( 'storeapi' );

		console.log( `\n${ '═'.repeat( 70 ) }` );
		console.log( '  COMPARISON' );
		console.log( `${ '═'.repeat( 70 ) }` );

		const med = arr => {
			const s = [ ...arr ].sort( ( a, b ) => a - b );
			return s[ Math.floor( s.length / 2 ) ];
		};

		const ci = classicInt.results;
		const si = storeapiInt.results;

		if ( ci.length && si.length ) {
			const metrics = [
				[ 'Server calls during fill', 'serverCallsDuringFill', '' ],
				[ 'Total interaction time', 'totalInteractionTime', 'ms' ],
				[ 'Field fill time', 'fieldFillTime', 'ms' ],
				[ 'Update wait', 'updateWaitTime', 'ms' ],
			];

			console.log( `\n  ${ 'Metric'.padEnd( 30 ) } ${ 'Classic'.padStart( 10 ) } ${ 'Store API'.padStart( 10 ) }` );
			console.log( `  ${ '─'.repeat( 55 ) }` );
			for ( const [ label, key, unit ] of metrics ) {
				const c = med( ci.map( r => r[ key ] ) );
				const s = med( si.map( r => r[ key ] ) );
				console.log( `  ${ label.padEnd( 30 ) } ${ ( c + unit ).padStart( 10 ) } ${ ( s + unit ).padStart( 10 ) }` );
			}
		}

		const cr = classicRet.results;
		const sr = storeapiRet.results;

		if ( cr.length && sr.length ) {
			console.log( `\n  Returning Visitor:` );
			console.log( `  ${ 'Metric'.padEnd( 30 ) } ${ 'Classic'.padStart( 10 ) } ${ 'Store API'.padStart( 10 ) }` );
			console.log( `  ${ '─'.repeat( 55 ) }` );
			console.log( `  ${ 'Cold load'.padEnd( 30 ) } ${ ( med( cr.map( r => r.coldTime ) ) + 'ms' ).padStart( 10 ) } ${ ( med( sr.map( r => r.coldTime ) ) + 'ms' ).padStart( 10 ) }` );
			console.log( `  ${ 'Warm load (cached)'.padEnd( 30 ) } ${ ( med( cr.map( r => r.warmTime ) ) + 'ms' ).padStart( 10 ) } ${ ( med( sr.map( r => r.warmTime ) ) + 'ms' ).padStart( 10 ) }` );
			console.log( `  ${ 'Cache benefit'.padEnd( 30 ) } ${ ( med( cr.map( r => r.improvement ) ) + '%' ).padStart( 10 ) } ${ ( med( sr.map( r => r.improvement ) ) + '%' ).padStart( 10 ) }` );
		}
	} else {
		await runInteractionTest( mode );
		await runReturningVisitorTest( mode );
	}
} )();

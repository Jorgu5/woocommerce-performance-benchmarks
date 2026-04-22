/**
 * Checkout Interaction Test — Returning Visitor (Warm Cache)
 *
 * Measures the full checkout interaction (page load → field fill → update wait)
 * for both cold (first visit) and warm (returning visitor) scenarios.
 *
 * For each run:
 *   1. Fresh browser, add to cart
 *   2. Cold: navigate to checkout, fill fields, measure everything
 *   3. New browser (same session cookie approach), add to cart
 *   4. Prime: navigate to checkout once (warm the cache)
 *   5. Warm: navigate to checkout again, fill fields, measure everything
 *
 * Usage:
 *   node interaction-cached.mjs all
 *   node interaction-cached.mjs classic
 *   node interaction-cached.mjs storeapi
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
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'interaction-cached' );
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

/**
 * Compute median of a numeric array.
 *
 * @param {number[]} arr Values.
 * @return {number} Median.
 */
function median( arr ) {
	const sorted = [ ...arr ].sort( ( a, b ) => a - b );
	const n = sorted.length;
	return n % 2 ? sorted[ Math.floor( n / 2 ) ] : ( sorted[ n / 2 - 1 ] + sorted[ n / 2 ] ) / 2;
}

/**
 * Add item to cart.
 *
 * @param {import('puppeteer').Page} page Puppeteer page.
 * @param {string}                   mode 'classic' or 'storeapi'.
 * @param {string}                   baseUrl Site URL.
 */
async function addToCart( page, mode, baseUrl ) {
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

	await sleep( 500 );
}

/**
 * Run a single checkout interaction measurement on an already-loaded page.
 * Navigates to checkout, fills fields, waits for updates.
 *
 * @param {import('puppeteer').Page} page    Puppeteer page.
 * @param {string}                   mode    'classic' or 'storeapi'.
 * @param {string}                   baseUrl Site URL.
 * @return {Object} Metrics object.
 */
async function measureInteraction( page, mode, baseUrl ) {
	// Track XHR/fetch requests during the interaction
	const networkRequests = [];
	const requestHandler = req => {
		if ( req.resourceType() === 'xhr' || req.resourceType() === 'fetch' ) {
			networkRequests.push( {
				url: req.url(),
				method: req.method(),
				time: Date.now(),
			} );
		}
	};
	page.on( 'request', requestHandler );

	// 1. Navigate to checkout
	const pageLoadStart = Date.now();
	await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
	const pageLoadTime = Date.now() - pageLoadStart;

	// 2. Wait for form to be interactive
	const ttiStart = Date.now();

	if ( mode === 'classic' ) {
		await page.waitForSelector( '#billing_first_name', { timeout: 15000 } ).catch( () => {} );
	} else {
		await page.waitForSelector(
			'input[id*="email"], .wc-block-components-text-input input',
			{ timeout: 15000 }
		).catch( () => {} );
		await sleep( 1000 ); // React hydration
	}

	const timeToInteractive = Date.now() - ttiStart;

	// Mark start of interaction phase for network tracking
	const preInteractionCount = networkRequests.length;

	// 3. Fill billing fields
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

	const fillStart = Date.now();
	const fieldTimings = [];

	for ( const [ selector, value ] of fields ) {
		const fieldStart = Date.now();
		try {
			const el = await page.$( selector );
			if ( el ) {
				await el.click( { clickCount: 3 } );
				await el.type( value, { delay: 30 } );
				await page.keyboard.press( 'Tab' );
				await sleep( 300 );
			}
		} catch ( e ) {
			// Field not found — skip
		}
		fieldTimings.push( Date.now() - fieldStart );
	}

	const fieldFillTime = Date.now() - fillStart;

	// 4. Wait for pending updates (shipping recalc)
	const updateWaitStart = Date.now();

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

	const updateWaitTime = Date.now() - updateWaitStart;
	const totalInteractionTime = ( Date.now() - fillStart );

	// 5. Count server requests during interaction
	const interactionRequests = networkRequests.slice( preInteractionCount );
	const ajaxCalls = interactionRequests.filter( r =>
		r.url.includes( 'wc-ajax' ) ||
		r.url.includes( 'wp-json' ) ||
		r.url.includes( 'admin-ajax' )
	);

	// Clean up listener
	page.off( 'request', requestHandler );

	return {
		pageLoadTime,
		timeToInteractive,
		fieldFillTime,
		updateWaitTime,
		totalInteractionTime,
		serverCalls: ajaxCalls.length,
		fieldTimings,
	};
}

/**
 * Run cold + warm interaction test for a given mode.
 *
 * @param {string} mode 'classic' or 'storeapi'.
 * @return {Object} { cold: metrics[], warm: metrics[] }
 */
async function runInteractionCached( mode ) {
	const baseUrl = URLS[ mode ];

	console.log( `\n${ '═'.repeat( 70 ) }` );
	console.log( `  ${ mode.toUpperCase() } — Checkout Interaction: Cold vs Warm (${ RUNS } runs)` );
	console.log( `${ '═'.repeat( 70 ) }` );

	const coldResults = [];
	const warmResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }` );

		// ── Cold interaction (fresh browser) ──────────────────────────
		console.log( '    [COLD] Fresh browser...' );

		const coldBrowser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ],
		} );

		const coldPage = await coldBrowser.newPage();
		await coldPage.setViewport( { width: 1366, height: 768 } );

		try {
			await addToCart( coldPage, mode, baseUrl );
			const coldMetrics = await measureInteraction( coldPage, mode, baseUrl );
			coldResults.push( coldMetrics );

			console.log(
				`    [COLD] Load: ${ coldMetrics.pageLoadTime }ms` +
				`  TTI: ${ coldMetrics.timeToInteractive }ms` +
				`  Fill: ${ coldMetrics.fieldFillTime }ms` +
				`  Update: ${ coldMetrics.updateWaitTime }ms` +
				`  Calls: ${ coldMetrics.serverCalls }`
			);
		} catch ( error ) {
			console.log( `    [COLD] Error: ${ error.message }` );
			coldResults.push( { error: error.message } );
		} finally {
			await coldBrowser.close();
		}

		// ── Warm interaction (primed browser) ─────────────────────────
		console.log( '    [WARM] Priming cache...' );

		const warmBrowser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ],
		} );

		const warmPage = await warmBrowser.newPage();
		await warmPage.setViewport( { width: 1366, height: 768 } );

		try {
			await addToCart( warmPage, mode, baseUrl );

			// Prime: load checkout once to cache all assets
			await warmPage.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );

			// Now navigate away and back so the second load uses cache
			await warmPage.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

			// Re-add to cart (session may have been cleared by navigation)
			await addToCart( warmPage, mode, baseUrl );

			const warmMetrics = await measureInteraction( warmPage, mode, baseUrl );
			warmResults.push( warmMetrics );

			console.log(
				`    [WARM] Load: ${ warmMetrics.pageLoadTime }ms` +
				`  TTI: ${ warmMetrics.timeToInteractive }ms` +
				`  Fill: ${ warmMetrics.fieldFillTime }ms` +
				`  Update: ${ warmMetrics.updateWaitTime }ms` +
				`  Calls: ${ warmMetrics.serverCalls }`
			);
		} catch ( error ) {
			console.log( `    [WARM] Error: ${ error.message }` );
			warmResults.push( { error: error.message } );
		} finally {
			await warmBrowser.close();
		}
	}

	// ── Summary ───────────────────────────────────────────────────────
	const validCold = coldResults.filter( r => ! r.error );
	const validWarm = warmResults.filter( r => ! r.error );

	if ( validCold.length > 0 && validWarm.length > 0 ) {
		console.log( `\n  ${ '─'.repeat( 65 ) }` );
		console.log( `  ${ mode.toUpperCase() } SUMMARY (${ validCold.length } cold, ${ validWarm.length } warm)` );

		const metrics = [
			[ 'Page load', 'pageLoadTime', 'ms' ],
			[ 'Time to interactive', 'timeToInteractive', 'ms' ],
			[ 'Field fill', 'fieldFillTime', 'ms' ],
			[ 'Update wait', 'updateWaitTime', 'ms' ],
			[ 'Total interaction', 'totalInteractionTime', 'ms' ],
			[ 'Server calls', 'serverCalls', '' ],
		];

		console.log( `  ${ 'Metric'.padEnd( 22 ) } ${ 'Cold'.padStart( 10 ) } ${ 'Warm'.padStart( 10 ) } ${ 'Diff'.padStart( 10 ) }` );
		console.log( `  ${ '─'.repeat( 55 ) }` );

		for ( const [ label, key, unit ] of metrics ) {
			const coldMed = median( validCold.map( r => r[ key ] ) );
			const warmMed = median( validWarm.map( r => r[ key ] ) );
			const diff = coldMed > 0
				? ( ( warmMed - coldMed ) / coldMed * 100 ).toFixed( 1 ) + '%'
				: '—';
			console.log(
				`  ${ label.padEnd( 22 ) }` +
				` ${ ( Math.round( coldMed ) + unit ).padStart( 10 ) }` +
				` ${ ( Math.round( warmMed ) + unit ).padStart( 10 ) }` +
				` ${ diff.padStart( 10 ) }`
			);
		}
	}

	// Save results
	fs.writeFileSync(
		path.join( RESULTS_DIR, `${ mode }-interaction-cached-${ Date.now() }.json` ),
		JSON.stringify( { mode, runs: RUNS, cold: coldResults, warm: warmResults }, null, 2 )
	);

	return { mode, cold: validCold, warm: validWarm };
}

/**
 * Print side-by-side comparison of both modes.
 *
 * @param {Object} classicData  Classic results.
 * @param {Object} storeapiData Store API results.
 */
function printComparison( classicData, storeapiData ) {
	console.log( `\n${ '═'.repeat( 90 ) }` );
	console.log( '  COLD vs WARM INTERACTION — COMPARISON' );
	console.log( `${ '═'.repeat( 90 ) }` );

	const metrics = [
		[ 'Page load', 'pageLoadTime', 'ms' ],
		[ 'Time to interactive', 'timeToInteractive', 'ms' ],
		[ 'Field fill', 'fieldFillTime', 'ms' ],
		[ 'Update wait', 'updateWaitTime', 'ms' ],
		[ 'Total interaction', 'totalInteractionTime', 'ms' ],
		[ 'Server calls', 'serverCalls', '' ],
	];

	console.log(
		`\n  ${ 'Metric'.padEnd( 22 ) }` +
		` │ ${ 'C Cold'.padStart( 9 ) }` +
		` │ ${ 'C Warm'.padStart( 9 ) }` +
		` │ ${ 'SA Cold'.padStart( 9 ) }` +
		` │ ${ 'SA Warm'.padStart( 9 ) }` +
		` │ ${ 'Cold Gap'.padStart( 10 ) }` +
		` │ ${ 'Warm Gap'.padStart( 10 ) }`
	);
	console.log( `  ${ '─'.repeat( 22 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

	for ( const [ label, key, unit ] of metrics ) {
		const cCold = median( classicData.cold.map( r => r[ key ] ) );
		const cWarm = median( classicData.warm.map( r => r[ key ] ) );
		const sCold = median( storeapiData.cold.map( r => r[ key ] ) );
		const sWarm = median( storeapiData.warm.map( r => r[ key ] ) );

		const fmt = ( v ) => Math.round( v ) + unit;
		const coldGap = cCold > 0 ? ( ( sCold - cCold ) / cCold * 100 ).toFixed( 1 ) + '%' : '—';
		const warmGap = cWarm > 0 ? ( ( sWarm - cWarm ) / cWarm * 100 ).toFixed( 1 ) + '%' : '—';

		console.log(
			`  ${ label.padEnd( 22 ) }` +
			` │ ${ fmt( cCold ).padStart( 9 ) }` +
			` │ ${ fmt( cWarm ).padStart( 9 ) }` +
			` │ ${ fmt( sCold ).padStart( 9 ) }` +
			` │ ${ fmt( sWarm ).padStart( 9 ) }` +
			` │ ${ coldGap.padStart( 10 ) }` +
			` │ ${ warmGap.padStart( 10 ) }`
		);
	}

	// Cache benefit per mode
	console.log( `\n  CACHE BENEFIT (page load improvement cold → warm)` );
	console.log( `  ${ '─'.repeat( 60 ) }` );

	for ( const [ label, data ] of [ [ 'Classic', classicData ], [ 'Store API', storeapiData ] ] ) {
		const coldLoad = median( data.cold.map( r => r.pageLoadTime ) );
		const warmLoad = median( data.warm.map( r => r.pageLoadTime ) );
		const benefit = ( ( coldLoad - warmLoad ) / coldLoad * 100 ).toFixed( 1 );

		const coldTotal = median( data.cold.map( r => r.totalInteractionTime + r.pageLoadTime + r.timeToInteractive ) );
		const warmTotal = median( data.warm.map( r => r.totalInteractionTime + r.pageLoadTime + r.timeToInteractive ) );
		const totalBenefit = ( ( coldTotal - warmTotal ) / coldTotal * 100 ).toFixed( 1 );

		console.log(
			`  ${ label.padEnd( 12 ) }` +
			`  Page load: ${ Math.round( coldLoad ) }ms → ${ Math.round( warmLoad ) }ms (${ benefit }%)` +
			`  | End-to-end: ${ Math.round( coldTotal ) }ms → ${ Math.round( warmTotal ) }ms (${ totalBenefit }%)`
		);
	}
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice( 2 );
const mode = args[ 0 ] || 'all';

( async () => {
	if ( mode === 'all' ) {
		const classicData = await runInteractionCached( 'classic' );
		const storeapiData = await runInteractionCached( 'storeapi' );
		printComparison( classicData, storeapiData );
	} else {
		await runInteractionCached( mode );
	}
} )();

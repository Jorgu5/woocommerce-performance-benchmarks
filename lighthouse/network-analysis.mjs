/**
 * Network Analysis + Mobile Throttling + Real User Flow
 *
 * Tests:
 * 1. HTTP/2 multiplexing — count parallel vs sequential requests on checkout
 * 2. Mobile 3G/4G throttling — measure checkout load under constrained network
 * 3. Full checkout flow — attempt classic + storeapi end-to-end in browser
 *
 * Usage:
 *   node network-analysis.mjs all
 *   node network-analysis.mjs http2
 *   node network-analysis.mjs throttle
 *   node network-analysis.mjs flow
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'network-analysis' );
fs.mkdirSync( RESULTS_DIR, { recursive: true } );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const RUNS = parseInt( process.env.RUNS || '3', 10 );

async function sleep( ms ) {
	return new Promise( r => setTimeout( r, ms ) );
}

// ── TEST 1: HTTP/2 Multiplexing Analysis ───────────────────────────

async function analyzeHttp2( mode ) {
	const baseUrl = URLS[ mode ];

	console.log( `\n${ '═'.repeat( 60 ) }` );
	console.log( `  ${ mode.toUpperCase() } — HTTP/2 Network Analysis` );
	console.log( `${ '═'.repeat( 60 ) }` );

	const browser = await puppeteer.launch( {
		headless: 'new',
		args: [ '--no-sandbox' ],
	} );

	const page = await browser.newPage();
	const client = await page.createCDPSession();
	await client.send( 'Network.enable' );

	// Add item to cart first
	await page.goto( `${ baseUrl }/`, { waitUntil: 'networkidle2' } );
	if ( mode === 'classic' ) {
		await page.evaluate( async () => {
			const f = new FormData();
			f.append( 'product_id', '15' );
			f.append( 'quantity', '2' );
			await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: f } );
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

	// Track requests during checkout page load
	const requests = [];
	client.on( 'Network.requestWillBeSent', params => {
		requests.push( {
			id: params.requestId,
			url: params.request.url,
			method: params.request.method,
			timestamp: params.timestamp,
			type: params.type,
		} );
	} );

	const responses = {};
	client.on( 'Network.responseReceived', params => {
		responses[ params.requestId ] = {
			status: params.response.status,
			protocol: params.response.protocol,
			timing: params.response.timing,
			headers: params.response.headers,
		};
	} );

	// Load checkout page
	await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
	await sleep( 2000 );

	// Analyze
	const apiRequests = requests.filter( r =>
		r.url.includes( 'wc-ajax' ) ||
		r.url.includes( 'wp-json' ) ||
		r.url.includes( 'admin-ajax' )
	);

	const jsRequests = requests.filter( r =>
		r.url.endsWith( '.js' ) || r.type === 'Script'
	);

	const cssRequests = requests.filter( r =>
		r.url.endsWith( '.css' ) || r.type === 'Stylesheet'
	);

	// Check protocols
	const protocols = {};
	for ( const [ id, resp ] of Object.entries( responses ) ) {
		const proto = resp.protocol || 'unknown';
		protocols[ proto ] = ( protocols[ proto ] || 0 ) + 1;
	}

	// Find parallel requests (overlapping timestamps)
	const sorted = [ ...requests ].sort( ( a, b ) => a.timestamp - b.timestamp );
	let maxConcurrent = 0;
	let concurrentCount = 0;

	for ( let i = 0; i < sorted.length; i++ ) {
		concurrentCount = 1;
		for ( let j = i + 1; j < sorted.length; j++ ) {
			if ( sorted[ j ].timestamp - sorted[ i ].timestamp < 0.1 ) {
				concurrentCount++;
			} else {
				break;
			}
		}
		maxConcurrent = Math.max( maxConcurrent, concurrentCount );
	}

	console.log( `  Total requests:     ${ requests.length }` );
	console.log( `  API/AJAX requests:  ${ apiRequests.length }` );
	console.log( `  JS files:           ${ jsRequests.length }` );
	console.log( `  CSS files:          ${ cssRequests.length }` );
	console.log( `  Protocols:          ${ JSON.stringify( protocols ) }` );
	console.log( `  Max concurrent:     ${ maxConcurrent }` );
	console.log( `  API calls:` );
	apiRequests.forEach( r => {
		const resp = responses[ r.id ];
		const proto = resp ? resp.protocol : '?';
		console.log( `    ${ r.method } ${ new URL( r.url ).pathname } [${ proto }]` );
	} );

	await browser.close();

	return {
		mode,
		totalRequests: requests.length,
		apiRequests: apiRequests.length,
		jsFiles: jsRequests.length,
		cssFiles: cssRequests.length,
		protocols,
		maxConcurrent,
		apiUrls: apiRequests.map( r => `${ r.method } ${ new URL( r.url ).pathname }` ),
	};
}

// ── TEST 2: Mobile Network Throttling ──────────────────────────────

async function throttleTest( mode, profile ) {
	const baseUrl = URLS[ mode ];
	const profiles = {
		'3g': { downloadThroughput: 1.5 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 300 },
		'4g': { downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 3 * 1024 * 1024 / 8, latency: 60 },
		'fast': { downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
	};

	const throttle = profiles[ profile ];

	const browser = await puppeteer.launch( {
		headless: 'new',
		args: [ '--no-sandbox' ],
	} );

	const page = await browser.newPage();
	const client = await page.createCDPSession();

	// Apply network throttling
	if ( profile !== 'fast' ) {
		await client.send( 'Network.emulateNetworkConditions', {
			offline: false,
			downloadThroughput: throttle.downloadThroughput,
			uploadThroughput: throttle.uploadThroughput,
			latency: throttle.latency,
		} );
	}

	// Mobile viewport
	await page.setViewport( { width: 375, height: 812, isMobile: true } );

	// Add item
	await page.goto( `${ baseUrl }/`, { waitUntil: 'networkidle2', timeout: 60000 } );
	if ( mode === 'classic' ) {
		await page.evaluate( async () => {
			const f = new FormData();
			f.append( 'product_id', '15' );
			f.append( 'quantity', '1' );
			await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: f } );
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

	// Measure checkout load
	const start = Date.now();
	await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2', timeout: 60000 } );
	const loadTime = Date.now() - start;

	// Measure data transferred
	const metrics = await page.metrics();
	const perfEntries = await page.evaluate( () => {
		const entries = performance.getEntriesByType( 'resource' );
		return entries.reduce( ( total, e ) => total + ( e.transferSize || 0 ), 0 );
	} );

	await browser.close();

	return { mode, profile, loadTime, transferSize: perfEntries };
}

async function runThrottleTests() {
	console.log( `\n${ '═'.repeat( 60 ) }` );
	console.log( `  MOBILE NETWORK THROTTLING — Checkout Page Load` );
	console.log( `${ '═'.repeat( 60 ) }` );

	const results = {};

	for ( const profile of [ 'fast', '4g', '3g' ] ) {
		for ( const mode of [ 'classic', 'storeapi' ] ) {
			const runs = [];
			for ( let i = 0; i < RUNS; i++ ) {
				const r = await throttleTest( mode, profile );
				runs.push( r );
			}

			const med = arr => {
				const s = [ ...arr ].sort( ( a, b ) => a - b );
				return s[ Math.floor( s.length / 2 ) ];
			};

			const medLoad = med( runs.map( r => r.loadTime ) );
			const medSize = med( runs.map( r => r.transferSize ) );
			const key = `${ mode }-${ profile }`;
			results[ key ] = { medLoad, medSize };

			console.log( `  ${ mode.padEnd( 10 ) } ${ profile.padEnd( 5 ) }  Load: ${ medLoad }ms  Transfer: ${ Math.round( medSize / 1024 ) }KB` );
		}
	}

	// Comparison
	console.log( `\n  ${ '─'.repeat( 55 ) }` );
	console.log( `  ${ 'Network'.padEnd( 8 ) } ${ 'Classic'.padStart( 10 ) } ${ 'StoreAPI'.padStart( 10 ) } ${ 'Gap'.padStart( 10 ) } ${ 'Size C'.padStart( 8 ) } ${ 'Size SA'.padStart( 8 ) }` );
	console.log( `  ${ '─'.repeat( 55 ) }` );
	for ( const profile of [ 'fast', '4g', '3g' ] ) {
		const c = results[ `classic-${ profile }` ];
		const s = results[ `storeapi-${ profile }` ];
		const gap = ( ( s.medLoad - c.medLoad ) / c.medLoad * 100 ).toFixed( 0 );
		console.log( `  ${ profile.padEnd( 8 ) } ${ ( c.medLoad + 'ms' ).padStart( 10 ) } ${ ( s.medLoad + 'ms' ).padStart( 10 ) } ${ ( gap + '%' ).padStart( 10 ) } ${ ( Math.round( c.medSize / 1024 ) + 'KB' ).padStart( 8 ) } ${ ( Math.round( s.medSize / 1024 ) + 'KB' ).padStart( 8 ) }` );
	}

	return results;
}

// ── TEST 3: Full Checkout Flow (Fix #8) ────────────────────────────

async function fullCheckoutFlow( mode ) {
	const baseUrl = URLS[ mode ];

	console.log( `\n${ '═'.repeat( 60 ) }` );
	console.log( `  ${ mode.toUpperCase() } — Full Checkout Flow (${ RUNS } runs)` );
	console.log( `${ '═'.repeat( 60 ) }` );

	const allResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }:` );

		const browser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu' ],
		} );

		const page = await browser.newPage();
		await page.setViewport( { width: 1366, height: 768 } );

		const totalStart = Date.now();
		const steps = {};

		try {
			// 1. Add item via fetch (reliable across both modes)
			await page.goto( `${ baseUrl }/`, { waitUntil: 'networkidle2' } );

			let addStart = Date.now();
			if ( mode === 'classic' ) {
				await page.evaluate( async () => {
					const f = new FormData();
					f.append( 'product_id', '15' );
					f.append( 'quantity', '2' );
					await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: f } );
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
			steps.addToCart = Date.now() - addStart;

			// 2. Navigate to checkout
			let navStart = Date.now();
			await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
			steps.checkoutLoad = Date.now() - navStart;

			// 3. Wait for form to be interactive
			let waitStart = Date.now();
			if ( mode === 'classic' ) {
				// Classic: wait for billing field OR the checkout form class
				await page.waitForSelector(
					'#billing_first_name, .woocommerce-checkout #billing_first_name, form.checkout #billing_first_name',
					{ timeout: 15000 }
				).catch( async () => {
					// Fallback: check if the page has ANY input field
					const hasInput = await page.evaluate( () =>
						document.querySelectorAll( 'input[type="text"]' ).length
					);
					console.log( `    Classic inputs found: ${ hasInput }` );
				} );
			} else {
				await page.waitForSelector(
					'input[id*="email"], .wc-block-components-text-input input',
					{ timeout: 15000 }
				).catch( () => {} );
				await sleep( 1000 );
			}
			steps.waitInteractive = Date.now() - waitStart;

			// 4. Fill fields
			let fillStart = Date.now();
			const fields = mode === 'classic'
				? {
					'#billing_first_name': 'Aoife',
					'#billing_last_name': 'Murphy',
					'#billing_address_1': '42 Grafton Street',
					'#billing_city': 'Dublin',
					'#billing_postcode': 'D02 YX88',
					'#billing_phone': '+35312345678',
					'#billing_email': `flow+${ Date.now() }@mk.test`,
				}
				: {
					'#email, input[id*="email"]': `flow+${ Date.now() }@mk.test`,
					'input[id*="first_name"], input[id*="first-name"]': 'Aoife',
					'input[id*="last_name"], input[id*="last-name"]': 'Murphy',
					'input[id*="address_1"], input[id*="address-1"]': '42 Grafton Street',
					'input[id*="city"]': 'Dublin',
					'input[id*="postcode"]': 'D02 YX88',
					'input[id*="phone"]': '+35312345678',
				};

			for ( const [ selector, value ] of Object.entries( fields ) ) {
				try {
					const el = await page.$( selector );
					if ( el ) {
						await el.click( { clickCount: 3 } );
						await el.type( value, { delay: 20 } );
						await page.keyboard.press( 'Tab' );
					}
				} catch ( e ) { /* */ }
			}
			steps.fillFields = Date.now() - fillStart;

			// 5. Wait for updates
			let updateStart = Date.now();
			await sleep( 2000 );
			if ( mode === 'classic' ) {
				await page.waitForFunction(
					() => ! document.querySelector( '.blockOverlay' ),
					{ timeout: 10000 }
				).catch( () => {} );
			} else {
				await page.waitForFunction(
					() => ! document.querySelector( '.wc-block-components-loading-mask' ),
					{ timeout: 10000 }
				).catch( () => {} );
			}
			steps.updateWait = Date.now() - updateStart;

			// 6. Find and click place order
			let submitStart = Date.now();
			let success = false;

			if ( mode === 'classic' ) {
				// Select COD if available
				const cod = await page.$( '#payment_method_cod' );
				if ( cod ) await cod.click();
				await sleep( 500 );

				const placeBtn = await page.$( '#place_order' );
				if ( placeBtn ) {
					await Promise.all( [
						page.waitForNavigation( { waitUntil: 'networkidle2', timeout: 30000 } ).catch( () => {} ),
						placeBtn.click(),
					] );
					success = page.url().includes( 'order-received' );
				}
			} else {
				const codRadio = await page.$(
					'input[value="cod"], .wc-block-components-radio-control__input[value="cod"]'
				);
				if ( codRadio ) {
					await codRadio.click();
					await sleep( 500 );
				}

				const placeBtn = await page.$(
					'.wc-block-components-checkout-place-order-button, button.wc-block-components-button'
				);
				if ( placeBtn ) {
					await Promise.all( [
						page.waitForNavigation( { waitUntil: 'networkidle2', timeout: 30000 } ).catch( () => {} ),
						placeBtn.click(),
					] );
					success = page.url().includes( 'order-received' );
				}
			}
			steps.submitAndRedirect = Date.now() - submitStart;

			steps.total = Date.now() - totalStart;
			steps.success = success;

			for ( const [ name, val ] of Object.entries( steps ) ) {
				if ( name === 'success' ) {
					console.log( `    ${ name }: ${ val ? '✓' : '✗' }` );
				} else {
					const bar = '█'.repeat( Math.min( Math.round( val / 100 ), 30 ) );
					console.log( `    ${ name.padEnd( 22 ) } ${ String( val ).padStart( 6 ) }ms  ${ bar }` );
				}
			}

			allResults.push( steps );
		} catch ( error ) {
			console.log( `    Error: ${ error.message }` );
			allResults.push( { error: error.message, success: false } );
		} finally {
			await browser.close();
		}
	}

	// Summary
	const valid = allResults.filter( r => r.total );
	const successful = valid.filter( r => r.success );

	if ( valid.length > 0 ) {
		const med = arr => {
			const s = [ ...arr ].sort( ( a, b ) => a - b );
			return s[ Math.floor( s.length / 2 ) ];
		};

		console.log( `\n  SUMMARY (${ successful.length }/${ valid.length } successful)` );
		console.log( `    Total: ${ med( valid.map( r => r.total ) ) }ms` );
		console.log( `    Checkout load: ${ med( valid.map( r => r.checkoutLoad ) ) }ms` );
		console.log( `    Fill fields: ${ med( valid.map( r => r.fillFields ) ) }ms` );
		console.log( `    Submit+redirect: ${ med( valid.map( r => r.submitAndRedirect ) ) }ms` );
	}

	fs.writeFileSync(
		path.join( RESULTS_DIR, `${ mode }-flow-${ Date.now() }.json` ),
		JSON.stringify( { mode, results: allResults }, null, 2 )
	);

	return { mode, valid, successful: successful.length };
}

// ── Main ───────────────────────────────────────────────────────────

const args = process.argv.slice( 2 );
const test = args[ 0 ] || 'all';

( async () => {
	if ( test === 'all' || test === 'http2' ) {
		const classicH2 = await analyzeHttp2( 'classic' );
		const storeapiH2 = await analyzeHttp2( 'storeapi' );

		console.log( `\n  HTTP/2 COMPARISON` );
		console.log( `  ${ 'Metric'.padEnd( 25 ) } ${ 'Classic'.padStart( 10 ) } ${ 'StoreAPI'.padStart( 10 ) }` );
		console.log( `  ${ '─'.repeat( 48 ) }` );
		console.log( `  ${ 'Total requests'.padEnd( 25 ) } ${ String( classicH2.totalRequests ).padStart( 10 ) } ${ String( storeapiH2.totalRequests ).padStart( 10 ) }` );
		console.log( `  ${ 'API/AJAX calls'.padEnd( 25 ) } ${ String( classicH2.apiRequests ).padStart( 10 ) } ${ String( storeapiH2.apiRequests ).padStart( 10 ) }` );
		console.log( `  ${ 'JS files'.padEnd( 25 ) } ${ String( classicH2.jsFiles ).padStart( 10 ) } ${ String( storeapiH2.jsFiles ).padStart( 10 ) }` );
		console.log( `  ${ 'CSS files'.padEnd( 25 ) } ${ String( classicH2.cssFiles ).padStart( 10 ) } ${ String( storeapiH2.cssFiles ).padStart( 10 ) }` );
		console.log( `  ${ 'Max concurrent requests'.padEnd( 25 ) } ${ String( classicH2.maxConcurrent ).padStart( 10 ) } ${ String( storeapiH2.maxConcurrent ).padStart( 10 ) }` );

		fs.writeFileSync( path.join( RESULTS_DIR, 'http2-analysis.json' ),
			JSON.stringify( { classic: classicH2, storeapi: storeapiH2 }, null, 2 ) );
	}

	if ( test === 'all' || test === 'throttle' ) {
		const throttleResults = await runThrottleTests();
		fs.writeFileSync( path.join( RESULTS_DIR, 'throttle-results.json' ),
			JSON.stringify( throttleResults, null, 2 ) );
	}

	if ( test === 'all' || test === 'flow' ) {
		const classicFlow = await fullCheckoutFlow( 'classic' );
		const storeapiFlow = await fullCheckoutFlow( 'storeapi' );

		console.log( `\n${ '═'.repeat( 60 ) }` );
		console.log( `  FULL CHECKOUT FLOW COMPARISON` );
		console.log( `${ '═'.repeat( 60 ) }` );
		console.log( `  Classic: ${ classicFlow.successful }/${ classicFlow.valid.length } successful` );
		console.log( `  StoreAPI: ${ storeapiFlow.successful }/${ storeapiFlow.valid.length } successful` );

		if ( classicFlow.valid.length && storeapiFlow.valid.length ) {
			const med = arr => {
				const s = [ ...arr ].sort( ( a, b ) => a - b );
				return s[ Math.floor( s.length / 2 ) ];
			};

			const metrics = [ 'checkoutLoad', 'fillFields', 'updateWait', 'submitAndRedirect', 'total' ];
			console.log( `\n  ${ 'Step'.padEnd( 25 ) } ${ 'Classic'.padStart( 10 ) } ${ 'StoreAPI'.padStart( 10 ) }` );
			console.log( `  ${ '─'.repeat( 48 ) }` );
			for ( const m of metrics ) {
				const c = med( classicFlow.valid.map( r => r[ m ] || 0 ) );
				const s = med( storeapiFlow.valid.map( r => r[ m ] || 0 ) );
				console.log( `  ${ m.padEnd( 25 ) } ${ ( c + 'ms' ).padStart( 10 ) } ${ ( s + 'ms' ).padStart( 10 ) }` );
			}
		}
	}
} )();

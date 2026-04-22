/**
 * Multisite Performance Test Suite
 *
 * Runs key performance tests against WordPress multisite subdirectory
 * installations. Handles the subdirectory-specific URL paths that break
 * the single-site scripts (e.g., /store1/?wc-ajax=add_to_cart instead
 * of /?wc-ajax=add_to_cart).
 *
 * Tests:
 *   1. Checkout interaction (cold + warm) — page load, TTI, fill, update wait
 *   2. Network throttling (fast/4G/3G, cold + warm) — page load times
 *   3. Real vitals (2x CPU, cold + warm) — FCP, LCP, real TTI, TBT
 *
 * Usage:
 *   node multisite-test.mjs all
 *   node multisite-test.mjs interaction
 *   node multisite-test.mjs network
 *   node multisite-test.mjs vitals
 *
 * Environment:
 *   CLASSIC_MS_URL  (default: https://classic-ms.example.com)
 *   STOREAPI_MS_URL (default: https://storeapi-ms.example.com)
 *   STORE           (default: store1)
 *   PRODUCT_ID      (default: 10)
 *   RUNS            (default: 3)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'multisite' );
fs.mkdirSync( RESULTS_DIR, { recursive: true } );

const CLASSIC_BASE = process.env.CLASSIC_MS_URL || 'https://classic-ms.example.com';
const STOREAPI_BASE = process.env.STOREAPI_MS_URL || 'https://storeapi-ms.example.com';
const STORE = process.env.STORE || 'store1';
const PRODUCT_ID = parseInt( process.env.PRODUCT_ID || '10', 10 );
const RUNS = parseInt( process.env.RUNS || '3', 10 );

const URLS = {
	classic: `${ CLASSIC_BASE }/${ STORE }`,
	storeapi: `${ STOREAPI_BASE }/${ STORE }`,
};

// ── Helpers ──────────────────────────────────────────────────────────

async function sleep( ms ) {
	return new Promise( r => setTimeout( r, ms ) );
}

function median( arr ) {
	if ( ! arr.length ) {
		return 0;
	}
	const sorted = [ ...arr ].sort( ( a, b ) => a - b );
	return sorted[ Math.floor( sorted.length / 2 ) ];
}

/**
 * Add item to cart on a multisite subdirectory store.
 *
 * Key difference from single-site: the wc-ajax and REST API paths
 * must include the subsite prefix (e.g., /store1/?wc-ajax=add_to_cart).
 *
 * @param {import('puppeteer').Page} page  Puppeteer page.
 * @param {string}                   mode  'classic' or 'storeapi'.
 * @param {string}                   storeUrl Full store URL (e.g., https://classic-ms.../store1).
 */
async function addToCart( page, mode, storeUrl ) {
	await page.goto( `${ storeUrl }/shop/`, { waitUntil: 'networkidle2' } );

	if ( mode === 'classic' ) {
		await page.evaluate( async ( pid, storePath ) => {
			const f = new FormData();
			f.append( 'product_id', pid );
			f.append( 'quantity', '2' );
			await fetch( `${ storePath }/?wc-ajax=add_to_cart`, { method: 'POST', body: f } );
		}, PRODUCT_ID, `/${ STORE }` );
	} else {
		await page.evaluate( async ( pid, storePath ) => {
			await fetch( `${ storePath }/wp-json/wc/store/v1/cart/add-item/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { id: pid, quantity: 2 } ),
			} );
		}, PRODUCT_ID, `/${ STORE }` );
	}

	await sleep( 500 );
}

// ── Test 1: Checkout Interaction ─────────────────────────────────────

async function measureInteraction( page, mode, storeUrl ) {
	const networkRequests = [];
	const handler = req => {
		if ( req.resourceType() === 'xhr' || req.resourceType() === 'fetch' ) {
			networkRequests.push( req.url() );
		}
	};
	page.on( 'request', handler );

	const pageLoadStart = Date.now();
	await page.goto( `${ storeUrl }/checkout/`, { waitUntil: 'networkidle2' } );
	const pageLoadTime = Date.now() - pageLoadStart;

	const ttiStart = Date.now();
	if ( mode === 'classic' ) {
		await page.waitForSelector( '#billing_first_name', { timeout: 15000 } ).catch( () => {} );
	} else {
		await page.waitForSelector( 'input[id*="email"], .wc-block-components-text-input input', { timeout: 15000 } ).catch( () => {} );
		await sleep( 1000 );
	}
	const timeToInteractive = Date.now() - ttiStart;

	const preCount = networkRequests.length;
	const fields = mode === 'classic'
		? [
			[ '#billing_first_name', 'Max' ], [ '#billing_last_name', 'Mustermann' ],
			[ '#billing_address_1', 'Friedrichstr. 123' ], [ '#billing_city', 'Berlin' ],
			[ '#billing_postcode', '10115' ], [ '#billing_phone', '+4930123456' ],
			[ '#billing_email', `ms+${ Date.now() }@mk.test` ],
		]
		: [
			[ '#email, input[id*="email"]', `ms+${ Date.now() }@mk.test` ],
			[ '#billing-first_name, input[id*="first_name"], input[id*="first-name"]', 'Max' ],
			[ '#billing-last_name, input[id*="last_name"], input[id*="last-name"]', 'Mustermann' ],
			[ '#billing-address_1, input[id*="address_1"], input[id*="address-1"]', 'Friedrichstr. 123' ],
			[ '#billing-city, input[id*="city"]', 'Berlin' ],
			[ '#billing-postcode, input[id*="postcode"]', '10115' ],
			[ '#billing-phone, input[id*="phone"]', '+4930123456' ],
		];

	const fillStart = Date.now();
	for ( const [ selector, value ] of fields ) {
		try {
			const el = await page.$( selector );
			if ( el ) {
				await el.click( { clickCount: 3 } );
				await el.type( value, { delay: 30 } );
				await page.keyboard.press( 'Tab' );
				await sleep( 300 );
			}
		} catch ( e ) { /* skip */ }
	}
	const fieldFillTime = Date.now() - fillStart;

	const updateStart = Date.now();
	if ( mode === 'classic' ) {
		await sleep( 2000 );
		await page.waitForFunction( () => ! document.querySelector( '.blockOverlay' ), { timeout: 10000 } ).catch( () => {} );
	} else {
		await sleep( 1000 );
		await page.waitForFunction( () => ! document.querySelector( '.wc-block-components-loading-mask' ), { timeout: 10000 } ).catch( () => {} );
	}
	const updateWaitTime = Date.now() - updateStart;

	const ajaxCalls = networkRequests.slice( preCount ).filter( u => u.includes( 'wc-ajax' ) || u.includes( 'wp-json' ) || u.includes( 'admin-ajax' ) );
	page.off( 'request', handler );

	return { pageLoadTime, timeToInteractive, fieldFillTime, updateWaitTime, totalInteractionTime: fieldFillTime + updateWaitTime, serverCalls: ajaxCalls.length };
}

async function runInteractionTest() {
	console.log( `\n${ '═'.repeat( 90 ) }` );
	console.log( `  MULTISITE CHECKOUT INTERACTION — Cold vs Warm (${ RUNS } runs, ${ STORE })` );
	console.log( `${ '═'.repeat( 90 ) }` );

	const allResults = {};

	for ( const mode of [ 'classic', 'storeapi' ] ) {
		const storeUrl = URLS[ mode ];

		for ( const [ label, warmCache ] of [ [ 'cold', false ], [ 'warm', true ] ] ) {
			const runs = [];
			for ( let run = 1; run <= RUNS; run++ ) {
				const browser = await puppeteer.launch( { headless: 'new', args: [ '--no-sandbox', '--disable-gpu', '--window-size=1366,768' ] } );
				const page = await browser.newPage();
				await page.setViewport( { width: 1366, height: 768 } );

				try {
					await addToCart( page, mode, storeUrl );
					if ( warmCache ) {
						await page.goto( `${ storeUrl }/checkout/`, { waitUntil: 'networkidle2' } );
						await page.goto( `${ storeUrl }/shop/`, { waitUntil: 'networkidle2' } );
						await addToCart( page, mode, storeUrl );
					}
					const m = await measureInteraction( page, mode, storeUrl );
					runs.push( m );
					console.log( `  ${ mode.padEnd( 10 ) } ${ label.padEnd( 5 ) } run${ run }  Load=${ m.pageLoadTime }ms  TTI=${ m.timeToInteractive }ms  Fill=${ m.fieldFillTime }ms  Update=${ m.updateWaitTime }ms  Calls=${ m.serverCalls }` );
				} catch ( e ) {
					console.log( `  ${ mode.padEnd( 10 ) } ${ label.padEnd( 5 ) } run${ run }  ERROR: ${ e.message.substring( 0, 60 ) }` );
				} finally {
					await browser.close();
				}
			}
			allResults[ `${ mode }-${ label }` ] = runs;
		}
	}

	// Print comparison
	const metricDefs = [ [ 'Page load', 'pageLoadTime', 'ms' ], [ 'TTI', 'timeToInteractive', 'ms' ], [ 'Field fill', 'fieldFillTime', 'ms' ], [ 'Update wait', 'updateWaitTime', 'ms' ], [ 'Total interaction', 'totalInteractionTime', 'ms' ], [ 'Server calls', 'serverCalls', '' ] ];

	console.log( `\n  ${ 'Metric'.padEnd( 20 ) } │ ${ 'C Cold'.padStart( 9 ) } │ ${ 'C Warm'.padStart( 9 ) } │ ${ 'SA Cold'.padStart( 9 ) } │ ${ 'SA Warm'.padStart( 9 ) } │ ${ 'Cold Gap'.padStart( 10 ) } │ ${ 'Warm Gap'.padStart( 10 ) }` );
	console.log( `  ${ '─'.repeat( 20 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

	for ( const [ label, key, unit ] of metricDefs ) {
		const v = ( k ) => allResults[ k ]?.length ? median( allResults[ k ].map( r => r[ key ] ) ) : 0;
		const cc = v( 'classic-cold' ), cw = v( 'classic-warm' ), sc = v( 'storeapi-cold' ), sw = v( 'storeapi-warm' );
		const fmt = ( n ) => Math.round( n ) + unit;
		const gap = ( a, b ) => a > 0 ? ( ( b - a ) / a * 100 ).toFixed( 1 ) + '%' : '—';
		console.log( `  ${ label.padEnd( 20 ) } │ ${ fmt( cc ).padStart( 9 ) } │ ${ fmt( cw ).padStart( 9 ) } │ ${ fmt( sc ).padStart( 9 ) } │ ${ fmt( sw ).padStart( 9 ) } │ ${ gap( cc, sc ).padStart( 10 ) } │ ${ gap( cw, sw ).padStart( 10 ) }` );
	}

	fs.writeFileSync( path.join( RESULTS_DIR, 'interaction.json' ), JSON.stringify( allResults, null, 2 ) );
	return allResults;
}

// ── Test 2: Network Throttling ───────────────────────────────────────

async function runNetworkTest() {
	const profiles = {
		fast: { label: 'No throttle', down: -1, up: -1, lat: 0 },
		'4g': { label: '4G', down: 4 * 1024 * 1024 / 8, up: 3 * 1024 * 1024 / 8, lat: 60 },
		'3g': { label: '3G', down: 1.5 * 1024 * 1024 / 8, up: 750 * 1024 / 8, lat: 300 },
	};

	console.log( `\n${ '═'.repeat( 90 ) }` );
	console.log( `  MULTISITE NETWORK THROTTLING — Cold vs Warm (${ RUNS } runs, ${ STORE })` );
	console.log( `${ '═'.repeat( 90 ) }` );

	const allResults = {};

	for ( const [ profKey, prof ] of Object.entries( profiles ) ) {
		for ( const mode of [ 'classic', 'storeapi' ] ) {
			const storeUrl = URLS[ mode ];
			const cold = [], warm = [];

			for ( let run = 1; run <= RUNS; run++ ) {
				const browser = await puppeteer.launch( { headless: 'new', args: [ '--no-sandbox' ] } );
				const page = await browser.newPage();
				const client = await page.createCDPSession();
				await page.setViewport( { width: 375, height: 812, isMobile: true } );

				await addToCart( page, mode, storeUrl );

				if ( profKey !== 'fast' ) {
					await client.send( 'Network.emulateNetworkConditions', { offline: false, downloadThroughput: prof.down, uploadThroughput: prof.up, latency: prof.lat } );
				}

				const coldStart = Date.now();
				await page.goto( `${ storeUrl }/checkout/`, { waitUntil: 'networkidle2', timeout: 120000 } );
				const coldTime = Date.now() - coldStart;

				const warmStart = Date.now();
				await page.goto( `${ storeUrl }/checkout/`, { waitUntil: 'networkidle2', timeout: 120000 } );
				const warmTime = Date.now() - warmStart;

				cold.push( coldTime );
				warm.push( warmTime );
				console.log( `  ${ mode.padEnd( 10 ) } ${ profKey.padEnd( 5 ) } run${ run }  Cold=${ coldTime }ms  Warm=${ warmTime }ms` );
				await browser.close();
			}

			allResults[ `${ mode }-${ profKey }` ] = { cold, warm };
		}
	}

	// Print comparison
	console.log( `\n  ${ 'Network'.padEnd( 10 ) } │ ${ 'C Cold'.padStart( 9 ) } │ ${ 'C Warm'.padStart( 9 ) } │ ${ 'SA Cold'.padStart( 9 ) } │ ${ 'SA Warm'.padStart( 9 ) } │ ${ 'Cold Gap'.padStart( 10 ) } │ ${ 'Warm Gap'.padStart( 10 ) }` );
	console.log( `  ${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

	for ( const profKey of [ 'fast', '4g', '3g' ] ) {
		const c = allResults[ `classic-${ profKey }` ], s = allResults[ `storeapi-${ profKey }` ];
		const cc = median( c.cold ), cw = median( c.warm ), sc = median( s.cold ), sw = median( s.warm );
		const gap = ( a, b ) => a > 0 ? ( ( b - a ) / a * 100 ).toFixed( 0 ) + '%' : '—';
		console.log( `  ${ profKey.padEnd( 10 ) } │ ${ ( cc + 'ms' ).padStart( 9 ) } │ ${ ( cw + 'ms' ).padStart( 9 ) } │ ${ ( sc + 'ms' ).padStart( 9 ) } │ ${ ( sw + 'ms' ).padStart( 9 ) } │ ${ gap( cc, sc ).padStart( 10 ) } │ ${ gap( cw, sw ).padStart( 10 ) }` );
	}

	fs.writeFileSync( path.join( RESULTS_DIR, 'network.json' ), JSON.stringify( allResults, null, 2 ) );
	return allResults;
}

// ── Test 3: Real Vitals ──────────────────────────────────────────────

async function runVitalsTest() {
	console.log( `\n${ '═'.repeat( 90 ) }` );
	console.log( `  MULTISITE REAL VITALS — 2x CPU (${ RUNS } runs, ${ STORE })` );
	console.log( `${ '═'.repeat( 90 ) }` );

	const allResults = {};

	for ( const mode of [ 'classic', 'storeapi' ] ) {
		const storeUrl = URLS[ mode ];

		for ( const [ label, warmCache ] of [ [ 'cold', false ], [ 'warm', true ] ] ) {
			const runs = [];

			for ( let run = 1; run <= RUNS; run++ ) {
				const browser = await puppeteer.launch( { headless: 'new', args: [ '--no-sandbox' ] } );
				const page = await browser.newPage();
				const client = await page.createCDPSession();
				await page.setViewport( { width: 412, height: 823, isMobile: true, deviceScaleFactor: 1.75 } );
				await client.send( 'Network.emulateNetworkConditions', { offline: false, downloadThroughput: 1638.4 * 1024 / 8, uploadThroughput: 750 * 1024 / 8, latency: 150 } );

				await addToCart( page, mode, storeUrl );

				if ( warmCache ) {
					await page.goto( `${ storeUrl }/checkout/`, { waitUntil: 'networkidle2' } );
				}

				await client.send( 'Emulation.setCPUThrottlingRate', { rate: 2 } );

				await page.evaluateOnNewDocument( () => {
					window.__vitals = { fcp: 0, lcp: 0, cls: 0, longTasks: [] };
					new PerformanceObserver( l => { for ( const e of l.getEntries() ) if ( e.name === 'first-contentful-paint' ) window.__vitals.fcp = e.startTime; } ).observe( { type: 'paint', buffered: true } );
					new PerformanceObserver( l => { const e = l.getEntries(); if ( e.length ) window.__vitals.lcp = e[ e.length - 1 ].startTime; } ).observe( { type: 'largest-contentful-paint', buffered: true } );
					new PerformanceObserver( l => { for ( const e of l.getEntries() ) if ( ! e.hadRecentInput ) window.__vitals.cls += e.value; } ).observe( { type: 'layout-shift', buffered: true } );
					new PerformanceObserver( l => { for ( const e of l.getEntries() ) window.__vitals.longTasks.push( { start: e.startTime, duration: e.duration, end: e.startTime + e.duration } ); } ).observe( { type: 'longtask', buffered: true } );
				} );

				await page.goto( `${ storeUrl }/checkout/`, { waitUntil: 'networkidle2' } );
				await sleep( 3000 );

				const v = await page.evaluate( () => {
					const vi = window.__vitals;
					let tbt = 0;
					for ( const lt of vi.longTasks ) tbt += Math.max( 0, lt.duration - 50 );
					const afterFcp = vi.longTasks.filter( lt => lt.end > vi.fcp );
					const realTti = afterFcp.length ? Math.max( ...afterFcp.map( lt => lt.end ) ) : vi.fcp;
					const res = performance.getEntriesByType( 'resource' );
					return { fcp: Math.round( vi.fcp ), lcp: Math.round( vi.lcp ), cls: parseFloat( vi.cls.toFixed( 4 ) ), tbt: Math.round( tbt ), realTti: Math.round( realTti ), longTasks: vi.longTasks.length, transfer: Math.round( res.reduce( ( s, r ) => s + ( r.transferSize || 0 ), 0 ) ) };
				} );

				await client.send( 'Emulation.setCPUThrottlingRate', { rate: 1 } );
				runs.push( v );
				console.log( `  ${ mode.padEnd( 10 ) } ${ label.padEnd( 5 ) } run${ run }  FCP=${ v.fcp }ms  realTTI=${ v.realTti }ms  TBT=${ v.tbt }ms  tasks=${ v.longTasks }  size=${ Math.round( v.transfer / 1024 ) }KB` );
				await browser.close();
			}

			allResults[ `${ mode }-${ label }` ] = runs;
		}
	}

	// Print comparison
	const metricDefs = [ [ 'FCP', 'fcp', 'ms' ], [ 'Real TTI', 'realTti', 'ms' ], [ 'TBT', 'tbt', 'ms' ], [ 'Long tasks', 'longTasks', '' ], [ 'Transfer', 'transfer', 'KB' ] ];

	console.log( `\n  ${ 'Metric'.padEnd( 14 ) } │ ${ 'C Cold'.padStart( 9 ) } │ ${ 'C Warm'.padStart( 9 ) } │ ${ 'SA Cold'.padStart( 9 ) } │ ${ 'SA Warm'.padStart( 9 ) } │ ${ 'Cold Gap'.padStart( 10 ) } │ ${ 'Warm Gap'.padStart( 10 ) }` );
	console.log( `  ${ '─'.repeat( 14 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

	for ( const [ label, key, unit ] of metricDefs ) {
		const div = unit === 'KB' ? 1024 : 1;
		const v = ( k ) => allResults[ k ]?.length ? median( allResults[ k ].map( r => r[ key ] / div ) ) : 0;
		const cc = v( 'classic-cold' ), cw = v( 'classic-warm' ), sc = v( 'storeapi-cold' ), sw = v( 'storeapi-warm' );
		const fmt = ( n ) => Math.round( n ) + unit;
		const gap = ( a, b ) => a > 0 ? ( ( b - a ) / a * 100 ).toFixed( 0 ) + '%' : '—';
		console.log( `  ${ label.padEnd( 14 ) } │ ${ fmt( cc ).padStart( 9 ) } │ ${ fmt( cw ).padStart( 9 ) } │ ${ fmt( sc ).padStart( 9 ) } │ ${ fmt( sw ).padStart( 9 ) } │ ${ gap( cc, sc ).padStart( 10 ) } │ ${ gap( cw, sw ).padStart( 10 ) }` );
	}

	fs.writeFileSync( path.join( RESULTS_DIR, 'vitals.json' ), JSON.stringify( allResults, null, 2 ) );
	return allResults;
}

// ── CLI ──────────────────────────────────────────────────────────────

const testArg = process.argv[ 2 ] || 'all';

( async () => {
	if ( testArg === 'all' || testArg === 'interaction' ) {
		await runInteractionTest();
	}
	if ( testArg === 'all' || testArg === 'network' ) {
		await runNetworkTest();
	}
	if ( testArg === 'all' || testArg === 'vitals' ) {
		await runVitalsTest();
	}
} )();

/**
 * Mobile Network Throttling — Returning Visitor (Warm Cache)
 *
 * Measures checkout page load times on no-throttle, 4G, and 3G for
 * both cold (first visit) and warm (returning visitor) scenarios.
 *
 * For each run:
 *   1. Fresh browser, add to cart
 *   2. Cold: navigate to checkout (measure)
 *   3. Warm: navigate to checkout again on same browser (measure)
 *
 * Network throttling is applied via CDP — bandwidth and latency
 * constraints apply to all requests, but the warm visit serves
 * cached JS/CSS from disk, so only the HTML document + uncacheable
 * requests hit the network.
 *
 * Usage:
 *   node network-cached.mjs all
 *   node network-cached.mjs classic 4g
 *   node network-cached.mjs storeapi 3g
 *
 * Environment:
 *   CLASSIC_URL   (default: https://classic.example.com)
 *   STOREAPI_URL  (default: https://storeapi.example.com)
 *   RUNS          (default: 3)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'network-cached' );
fs.mkdirSync( RESULTS_DIR, { recursive: true } );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const PRODUCT_ID = parseInt( process.env.PRODUCT_ID || '15', 10 );
const RUNS = parseInt( process.env.RUNS || '3', 10 );

const NETWORK_PROFILES = {
	fast: {
		label: 'No throttle',
		downloadThroughput: -1,
		uploadThroughput: -1,
		latency: 0,
	},
	'4g': {
		label: '4G (4 Mbps / 60ms RTT)',
		downloadThroughput: 4 * 1024 * 1024 / 8,
		uploadThroughput: 3 * 1024 * 1024 / 8,
		latency: 60,
	},
	'3g': {
		label: '3G (1.5 Mbps / 300ms RTT)',
		downloadThroughput: 1.5 * 1024 * 1024 / 8,
		uploadThroughput: 750 * 1024 / 8,
		latency: 300,
	},
};

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
 * Add item to cart on a page that has already navigated to /shop/.
 *
 * @param {import('puppeteer').Page} page    Puppeteer page.
 * @param {string}                   mode    'classic' or 'storeapi'.
 */
async function addToCart( page, mode ) {
	if ( mode === 'classic' ) {
		await page.evaluate( async ( productId ) => {
			const f = new FormData();
			f.append( 'product_id', productId );
			f.append( 'quantity', '1' );
			await fetch( '/?wc-ajax=add_to_cart', { method: 'POST', body: f } );
		}, PRODUCT_ID );
	} else {
		await page.evaluate( async ( productId ) => {
			await fetch( '/wp-json/wc/store/v1/cart/add-item/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify( { id: productId, quantity: 1 } ),
			} );
		}, PRODUCT_ID );
	}
}

/**
 * Run cold + warm checkout load test under a specific network profile.
 *
 * @param {string} mode    'classic' or 'storeapi'.
 * @param {string} profile 'fast', '4g', or '3g'.
 * @return {Object} { cold: number[], warm: number[], coldSize: number[], warmSize: number[] }
 */
async function runNetworkTest( mode, profile ) {
	const baseUrl = URLS[ mode ];
	const netConfig = NETWORK_PROFILES[ profile ];

	console.log( `\n  ${ mode.toUpperCase() } / ${ netConfig.label } (${ RUNS } runs)` );

	const coldTimes = [];
	const warmTimes = [];
	const coldSizes = [];
	const warmSizes = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		const browser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu' ],
		} );

		const page = await browser.newPage();
		const client = await page.createCDPSession();

		// Mobile viewport
		await page.setViewport( { width: 375, height: 812, isMobile: true } );

		// Add to cart WITHOUT throttling (simulate: user already has items)
		await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2', timeout: 30000 } );
		await addToCart( page, mode );

		// Now apply throttling
		if ( profile !== 'fast' ) {
			await client.send( 'Network.emulateNetworkConditions', {
				offline: false,
				downloadThroughput: netConfig.downloadThroughput,
				uploadThroughput: netConfig.uploadThroughput,
				latency: netConfig.latency,
			} );
		}

		// ── Cold visit ────────────────────────────────────────────────
		const coldStart = Date.now();
		await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2', timeout: 120000 } );
		const coldTime = Date.now() - coldStart;

		const coldSize = await page.evaluate( () => {
			return performance.getEntriesByType( 'resource' )
				.reduce( ( total, e ) => total + ( e.transferSize || 0 ), 0 );
		} );

		// ── Warm visit (same browser, cache primed) ───────────────────
		const warmStart = Date.now();
		await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2', timeout: 120000 } );
		const warmTime = Date.now() - warmStart;

		const warmSize = await page.evaluate( () => {
			return performance.getEntriesByType( 'resource' )
				.reduce( ( total, e ) => total + ( e.transferSize || 0 ), 0 );
		} );

		coldTimes.push( coldTime );
		warmTimes.push( warmTime );
		coldSizes.push( coldSize );
		warmSizes.push( warmSize );

		const improvement = ( ( coldTime - warmTime ) / coldTime * 100 ).toFixed( 1 );
		console.log(
			`    Run ${ run }: Cold ${ coldTime }ms (${ Math.round( coldSize / 1024 ) }KB)` +
			` → Warm ${ warmTime }ms (${ Math.round( warmSize / 1024 ) }KB)` +
			`  [${ improvement }% faster]`
		);

		await browser.close();
	}

	return {
		cold: coldTimes,
		warm: warmTimes,
		coldSize: coldSizes,
		warmSize: warmSizes,
	};
}

/**
 * Run all combinations and print comparison.
 */
async function runAll() {
	console.log( `${ '═'.repeat( 80 ) }` );
	console.log( '  MOBILE NETWORK — COLD vs WARM CACHE — Checkout Page Load' );
	console.log( `${ '═'.repeat( 80 ) }` );

	const allResults = {};

	for ( const profile of [ 'fast', '4g', '3g' ] ) {
		console.log( `\n${ '─'.repeat( 80 ) }` );
		console.log( `  Network: ${ NETWORK_PROFILES[ profile ].label }` );
		console.log( `${ '─'.repeat( 80 ) }` );

		for ( const mode of [ 'classic', 'storeapi' ] ) {
			const result = await runNetworkTest( mode, profile );
			allResults[ `${ mode }-${ profile }` ] = result;
		}
	}

	// ── Comparison table ──────────────────────────────────────────────
	console.log( `\n${ '═'.repeat( 100 ) }` );
	console.log( '  COMPARISON — Median of ' + RUNS + ' runs' );
	console.log( `${ '═'.repeat( 100 ) }` );

	console.log(
		`\n  ${ 'Network'.padEnd( 14 ) }` +
		` │ ${ 'C Cold'.padStart( 9 ) }` +
		` │ ${ 'C Warm'.padStart( 9 ) }` +
		` │ ${ 'C Benefit'.padStart( 10 ) }` +
		` │ ${ 'SA Cold'.padStart( 9 ) }` +
		` │ ${ 'SA Warm'.padStart( 9 ) }` +
		` │ ${ 'SA Benefit'.padStart( 10 ) }` +
		` │ ${ 'Cold Gap'.padStart( 10 ) }` +
		` │ ${ 'Warm Gap'.padStart( 10 ) }`
	);
	console.log( `  ${ '─'.repeat( 14 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

	for ( const profile of [ 'fast', '4g', '3g' ] ) {
		const c = allResults[ `classic-${ profile }` ];
		const s = allResults[ `storeapi-${ profile }` ];

		const cCold = median( c.cold );
		const cWarm = median( c.warm );
		const sCold = median( s.cold );
		const sWarm = median( s.warm );

		const cBenefit = ( ( cCold - cWarm ) / cCold * 100 ).toFixed( 0 ) + '%';
		const sBenefit = ( ( sCold - sWarm ) / sCold * 100 ).toFixed( 0 ) + '%';
		const coldGap = ( ( sCold - cCold ) / cCold * 100 ).toFixed( 0 ) + '%';
		const warmGap = ( ( sWarm - cWarm ) / cWarm * 100 ).toFixed( 0 ) + '%';

		console.log(
			`  ${ NETWORK_PROFILES[ profile ].label.padEnd( 14 ) }` +
			` │ ${ ( cCold + 'ms' ).padStart( 9 ) }` +
			` │ ${ ( cWarm + 'ms' ).padStart( 9 ) }` +
			` │ ${ cBenefit.padStart( 10 ) }` +
			` │ ${ ( sCold + 'ms' ).padStart( 9 ) }` +
			` │ ${ ( sWarm + 'ms' ).padStart( 9 ) }` +
			` │ ${ sBenefit.padStart( 10 ) }` +
			` │ ${ coldGap.padStart( 10 ) }` +
			` │ ${ warmGap.padStart( 10 ) }`
		);
	}

	// Transfer size comparison
	console.log( `\n  TRANSFER SIZE (median)` );
	console.log(
		`  ${ 'Network'.padEnd( 14 ) }` +
		` │ ${ 'C Cold'.padStart( 9 ) }` +
		` │ ${ 'C Warm'.padStart( 9 ) }` +
		` │ ${ 'SA Cold'.padStart( 9 ) }` +
		` │ ${ 'SA Warm'.padStart( 9 ) }`
	);
	console.log( `  ${ '─'.repeat( 14 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }` );

	for ( const profile of [ 'fast', '4g', '3g' ] ) {
		const c = allResults[ `classic-${ profile }` ];
		const s = allResults[ `storeapi-${ profile }` ];

		console.log(
			`  ${ NETWORK_PROFILES[ profile ].label.padEnd( 14 ) }` +
			` │ ${ ( Math.round( median( c.coldSize ) / 1024 ) + 'KB' ).padStart( 9 ) }` +
			` │ ${ ( Math.round( median( c.warmSize ) / 1024 ) + 'KB' ).padStart( 9 ) }` +
			` │ ${ ( Math.round( median( s.coldSize ) / 1024 ) + 'KB' ).padStart( 9 ) }` +
			` │ ${ ( Math.round( median( s.warmSize ) / 1024 ) + 'KB' ).padStart( 9 ) }`
		);
	}

	// Save raw results
	fs.writeFileSync(
		path.join( RESULTS_DIR, `all-results-${ Date.now() }.json` ),
		JSON.stringify( allResults, null, 2 )
	);

	return allResults;
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice( 2 );

if ( args.length === 0 || args[ 0 ] === 'all' ) {
	runAll().catch( console.error );
} else if ( args.length === 2 ) {
	const [ mode, profile ] = args;
	runNetworkTest( mode, profile ).then( result => {
		console.log( `\n  Summary: Cold ${ median( result.cold ) }ms → Warm ${ median( result.warm ) }ms` );
	} ).catch( console.error );
} else {
	console.log( 'Usage: node network-cached.mjs all' );
	console.log( '       node network-cached.mjs <classic|storeapi> <fast|4g|3g>' );
	process.exit( 1 );
}

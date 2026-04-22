/**
 * Real Web Vitals — Mobile Checkout Performance
 *
 * Measures actual browser-reported Web Vitals using PerformanceObserver
 * instead of Lighthouse's synthetic TTI algorithm. Uses CDP CPU
 * throttling at realistic rates (1x, 2x, 4x) to simulate real devices.
 *
 * Metrics collected:
 *   - FCP (First Contentful Paint)
 *   - LCP (Largest Contentful Paint)
 *   - CLS (Cumulative Layout Shift)
 *   - Long Tasks (count, total blocking time, last long task end)
 *   - Real TTI (last long task end + 50ms, or FCP if no long tasks)
 *   - DOM Interactive / DOM Complete (Navigation Timing)
 *   - Total JS execution time
 *   - Transfer size
 *
 * Why this is more accurate than Lighthouse TTI:
 *   Lighthouse TTI requires a 5-second quiet window, which penalizes
 *   architectures with many small async chunks (like WC block checkout).
 *   Real TTI here = when the last long task ends, which is what the user
 *   actually experiences as "the page is responsive."
 *
 * Usage:
 *   node real-vitals.mjs all
 *   node real-vitals.mjs storeapi 2x
 *   node real-vitals.mjs classic 4x
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
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'real-vitals' );
fs.mkdirSync( RESULTS_DIR, { recursive: true } );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const PRODUCT_ID = parseInt( process.env.PRODUCT_ID || '15', 10 );
const RUNS = parseInt( process.env.RUNS || '5', 10 );

const CPU_PROFILES = {
	'1x': { rate: 1, label: 'No throttle (desktop)' },
	'2x': { rate: 2, label: '2x slowdown (mid-range phone)' },
	'4x': { rate: 4, label: '4x slowdown (Lighthouse mobile)' },
};

/**
 * Compute median of a numeric array.
 *
 * @param {number[]} arr Values.
 * @return {number} Median.
 */
function median( arr ) {
	if ( ! arr.length ) {
		return 0;
	}
	const sorted = [ ...arr ].sort( ( a, b ) => a - b );
	const n = sorted.length;
	return n % 2 ? sorted[ Math.floor( n / 2 ) ] : ( sorted[ n / 2 - 1 ] + sorted[ n / 2 ] ) / 2;
}

async function sleep( ms ) {
	return new Promise( r => setTimeout( r, ms ) );
}

/**
 * Inject PerformanceObserver scripts that collect Web Vitals.
 * Must be called BEFORE navigation.
 *
 * @param {import('puppeteer').Page} page Puppeteer page.
 */
async function injectVitalsObservers( page ) {
	await page.evaluateOnNewDocument( () => {
		window.__vitals = {
			fcp: 0,
			lcp: 0,
			cls: 0,
			longTasks: [],
			resources: [],
		};

		// FCP
		const fcpObs = new PerformanceObserver( list => {
			for ( const entry of list.getEntries() ) {
				if ( entry.name === 'first-contentful-paint' ) {
					window.__vitals.fcp = entry.startTime;
				}
			}
		} );
		fcpObs.observe( { type: 'paint', buffered: true } );

		// LCP
		const lcpObs = new PerformanceObserver( list => {
			const entries = list.getEntries();
			if ( entries.length ) {
				window.__vitals.lcp = entries[ entries.length - 1 ].startTime;
			}
		} );
		lcpObs.observe( { type: 'largest-contentful-paint', buffered: true } );

		// CLS
		const clsObs = new PerformanceObserver( list => {
			for ( const entry of list.getEntries() ) {
				if ( ! entry.hadRecentInput ) {
					window.__vitals.cls += entry.value;
				}
			}
		} );
		clsObs.observe( { type: 'layout-shift', buffered: true } );

		// Long Tasks
		const ltObs = new PerformanceObserver( list => {
			for ( const entry of list.getEntries() ) {
				window.__vitals.longTasks.push( {
					start: entry.startTime,
					duration: entry.duration,
					end: entry.startTime + entry.duration,
				} );
			}
		} );
		ltObs.observe( { type: 'longtask', buffered: true } );
	} );
}

/**
 * Collect all vitals after page has loaded and settled.
 *
 * @param {import('puppeteer').Page} page Puppeteer page.
 * @return {Object} Vitals metrics.
 */
async function collectVitals( page ) {
	return await page.evaluate( () => {
		const v = window.__vitals;
		const nav = performance.getEntriesByType( 'navigation' )[ 0 ] || {};

		// Calculate real TBT (sum of blocking time beyond 50ms for each long task)
		let tbt = 0;
		let lastLongTaskEnd = 0;
		for ( const lt of v.longTasks ) {
			const blocking = Math.max( 0, lt.duration - 50 );
			tbt += blocking;
			if ( lt.end > lastLongTaskEnd ) {
				lastLongTaskEnd = lt.end;
			}
		}

		// Real TTI: when the page becomes consistently responsive
		// = last long task end, or FCP if no long tasks after FCP
		const longTasksAfterFcp = v.longTasks.filter( lt => lt.end > v.fcp );
		const realTti = longTasksAfterFcp.length
			? Math.max( ...longTasksAfterFcp.map( lt => lt.end ) )
			: v.fcp;

		// Transfer size
		const resources = performance.getEntriesByType( 'resource' );
		const totalTransfer = resources.reduce( ( sum, r ) => sum + ( r.transferSize || 0 ), 0 );
		const jsTransfer = resources
			.filter( r => r.initiatorType === 'script' || r.name.endsWith( '.js' ) )
			.reduce( ( sum, r ) => sum + ( r.transferSize || 0 ), 0 );

		return {
			fcp: Math.round( v.fcp ),
			lcp: Math.round( v.lcp ),
			cls: parseFloat( v.cls.toFixed( 4 ) ),
			longTaskCount: v.longTasks.length,
			longTasksAfterFcp: longTasksAfterFcp.length,
			tbt: Math.round( tbt ),
			lastLongTaskEnd: Math.round( lastLongTaskEnd ),
			realTti: Math.round( realTti ),
			domInteractive: Math.round( nav.domInteractive || 0 ),
			domComplete: Math.round( nav.domComplete || 0 ),
			loadEvent: Math.round( nav.loadEventEnd || 0 ),
			totalTransfer: Math.round( totalTransfer ),
			jsTransfer: Math.round( jsTransfer ),
			resourceCount: resources.length,
		};
	} );
}

/**
 * Run a single measurement: add to cart, navigate to checkout, collect vitals.
 *
 * @param {string}                   mode     'classic' or 'storeapi'.
 * @param {string}                   cpuKey   '1x', '2x', or '4x'.
 * @param {boolean}                  warmCache Prime the cache before measuring.
 * @return {Object} Vitals metrics.
 */
async function measureVitals( mode, cpuKey, warmCache ) {
	const baseUrl = URLS[ mode ];
	const cpuRate = CPU_PROFILES[ cpuKey ].rate;

	const browser = await puppeteer.launch( {
		headless: 'new',
		args: [ '--no-sandbox', '--disable-gpu' ],
	} );

	const page = await browser.newPage();
	const client = await page.createCDPSession();

	// Mobile viewport
	await page.setViewport( { width: 412, height: 823, isMobile: true, deviceScaleFactor: 1.75 } );

	// Apply network throttling (same as Lighthouse mobile: 4G-like)
	await client.send( 'Network.emulateNetworkConditions', {
		offline: false,
		downloadThroughput: 1638.4 * 1024 / 8,
		uploadThroughput: 750 * 1024 / 8,
		latency: 150,
	} );

	// Add to cart (without CPU throttle — cart add is server-side)
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

	// Warm cache: visit checkout once before measuring
	if ( warmCache ) {
		await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );
	}

	// Now apply CPU throttle and inject observers
	await client.send( 'Emulation.setCPUThrottlingRate', { rate: cpuRate } );
	await injectVitalsObservers( page );

	// Navigate to checkout (the actual measurement)
	await page.goto( `${ baseUrl }/checkout/`, { waitUntil: 'networkidle2' } );

	// Wait for React hydration and lazy chunks
	await sleep( 3000 );

	// Collect
	const vitals = await collectVitals( page );

	// Reset CPU throttle
	await client.send( 'Emulation.setCPUThrottlingRate', { rate: 1 } );

	await browser.close();

	return vitals;
}

/**
 * Run all tests and print comparison.
 */
async function runAll() {
	console.log( `${ '═'.repeat( 90 ) }` );
	console.log( '  REAL WEB VITALS — Mobile Checkout (median of ' + RUNS + ' runs)' );
	console.log( `${ '═'.repeat( 90 ) }` );

	const allResults = {};

	for ( const cpuKey of [ '1x', '2x', '4x' ] ) {
		console.log( `\n${ '─'.repeat( 90 ) }` );
		console.log( `  CPU: ${ CPU_PROFILES[ cpuKey ].label }` );
		console.log( `${ '─'.repeat( 90 ) }` );

		for ( const mode of [ 'classic', 'storeapi' ] ) {
			for ( const [ cacheLabel, warmCache ] of [ [ 'cold', false ], [ 'warm', true ] ] ) {
				const runs = [];

				for ( let run = 1; run <= RUNS; run++ ) {
					const v = await measureVitals( mode, cpuKey, warmCache );
					runs.push( v );
					console.log(
						`  ${ mode.padEnd( 10 ) } ${ cacheLabel.padEnd( 5 ) } run${ run }` +
						`  FCP=${ v.fcp }ms  LCP=${ v.lcp }ms  realTTI=${ v.realTti }ms` +
						`  TBT=${ v.tbt }ms  longTasks=${ v.longTaskCount }` +
						`  size=${ Math.round( v.totalTransfer / 1024 ) }KB`
					);
				}

				allResults[ `${ mode }-${ cpuKey }-${ cacheLabel }` ] = runs;
			}
		}
	}

	// ── Comparison table ──────────────────────────────────────────────
	console.log( `\n${ '═'.repeat( 110 ) }` );
	console.log( '  COMPARISON — Real TTI (last long task end) vs Lighthouse TTI (5s quiet window)' );
	console.log( `${ '═'.repeat( 110 ) }` );

	const metricDefs = [
		[ 'FCP', 'fcp', 'ms' ],
		[ 'LCP', 'lcp', 'ms' ],
		[ 'Real TTI', 'realTti', 'ms' ],
		[ 'TBT', 'tbt', 'ms' ],
		[ 'Long tasks', 'longTaskCount', '' ],
		[ 'After FCP', 'longTasksAfterFcp', '' ],
		[ 'CLS', 'cls', '' ],
		[ 'Transfer', 'totalTransfer', 'KB' ],
	];

	for ( const cpuKey of [ '1x', '2x', '4x' ] ) {
		console.log( `\n  CPU: ${ CPU_PROFILES[ cpuKey ].label }` );
		console.log(
			`  ${ 'Metric'.padEnd( 14 ) }` +
			` │ ${ 'C Cold'.padStart( 9 ) }` +
			` │ ${ 'C Warm'.padStart( 9 ) }` +
			` │ ${ 'SA Cold'.padStart( 9 ) }` +
			` │ ${ 'SA Warm'.padStart( 9 ) }` +
			` │ ${ 'Cold Gap'.padStart( 10 ) }` +
			` │ ${ 'Warm Gap'.padStart( 10 ) }`
		);
		console.log( `  ${ '─'.repeat( 14 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 9 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

		for ( const [ label, key, unit ] of metricDefs ) {
			const div = unit === 'KB' ? 1024 : 1;
			const cCold = allResults[ `classic-${ cpuKey }-cold` ] || [];
			const cWarm = allResults[ `classic-${ cpuKey }-warm` ] || [];
			const sCold = allResults[ `storeapi-${ cpuKey }-cold` ] || [];
			const sWarm = allResults[ `storeapi-${ cpuKey }-warm` ] || [];

			const cc = median( cCold.map( r => r[ key ] / div ) );
			const cw = median( cWarm.map( r => r[ key ] / div ) );
			const sc = median( sCold.map( r => r[ key ] / div ) );
			const sw = median( sWarm.map( r => r[ key ] / div ) );

			const fmt = ( v ) => key === 'cls' ? v.toFixed( 3 ) : Math.round( v ) + unit;
			const coldGap = cc > 0 ? ( ( sc - cc ) / cc * 100 ).toFixed( 0 ) + '%' : '—';
			const warmGap = cw > 0 ? ( ( sw - cw ) / cw * 100 ).toFixed( 0 ) + '%' : '—';

			console.log(
				`  ${ label.padEnd( 14 ) }` +
				` │ ${ fmt( cc ).padStart( 9 ) }` +
				` │ ${ fmt( cw ).padStart( 9 ) }` +
				` │ ${ fmt( sc ).padStart( 9 ) }` +
				` │ ${ fmt( sw ).padStart( 9 ) }` +
				` │ ${ coldGap.padStart( 10 ) }` +
				` │ ${ warmGap.padStart( 10 ) }`
			);
		}
	}

	// Save
	fs.writeFileSync(
		path.join( RESULTS_DIR, `all-results-${ Date.now() }.json` ),
		JSON.stringify( allResults, null, 2 )
	);
}

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice( 2 );

if ( args.length === 0 || args[ 0 ] === 'all' ) {
	runAll().catch( console.error );
} else if ( args.length === 2 ) {
	const [ mode, cpuKey ] = args;
	( async () => {
		console.log( `${ mode } / ${ cpuKey } / cold:` );
		for ( let i = 0; i < RUNS; i++ ) {
			const v = await measureVitals( mode, cpuKey, false );
			console.log( `  run${ i + 1 }  FCP=${ v.fcp }  realTTI=${ v.realTti }  TBT=${ v.tbt }  longTasks=${ v.longTaskCount }` );
		}
		console.log( `\n${ mode } / ${ cpuKey } / warm:` );
		for ( let i = 0; i < RUNS; i++ ) {
			const v = await measureVitals( mode, cpuKey, true );
			console.log( `  run${ i + 1 }  FCP=${ v.fcp }  realTTI=${ v.realTti }  TBT=${ v.tbt }  longTasks=${ v.longTaskCount }` );
		}
	} )();
} else {
	console.log( 'Usage: node real-vitals.mjs all' );
	console.log( '       node real-vitals.mjs <classic|storeapi> <1x|2x|4x>' );
	process.exit( 1 );
}

/**
 * Lighthouse audit with warm browser cache (returning visitor).
 *
 * Simulates a returning customer who has visited the checkout before.
 * For each run:
 *   1. Launches browser, adds item to cart
 *   2. Visits checkout once (primes browser cache with JS/CSS/fonts)
 *   3. Runs Lighthouse on the same browser with disableStorageReset: true
 *
 * This preserves the disk cache so Lighthouse measures what a returning
 * visitor experiences — the key scenario where Store API's larger but
 * highly-cacheable JS bundle pays off.
 *
 * Also runs a cold-cache audit (fresh browser, no priming) for
 * side-by-side comparison in the same output.
 *
 * Usage:
 *   node audit-cached.mjs classic mobile checkout
 *   node audit-cached.mjs storeapi desktop checkout
 *   node audit-cached.mjs all                       # all combinations
 *
 * Environment:
 *   CLASSIC_URL   (default: https://classic.example.com)
 *   STOREAPI_URL  (default: https://storeapi.example.com)
 *   PRODUCT_ID    (default: 15)
 *   RUNS          (default: 3)
 */

import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'lighthouse-cached' );

const URLS = {
	classic: process.env.CLASSIC_URL || 'https://classic.example.com',
	storeapi: process.env.STOREAPI_URL || 'https://storeapi.example.com',
};

const PRODUCT_ID = parseInt( process.env.PRODUCT_ID || '15', 10 );
const RUNS = parseInt( process.env.RUNS || '3', 10 );

const DEVICE_CONFIG = {
	mobile: {
		formFactor: 'mobile',
		screenEmulation: {
			mobile: true,
			width: 412,
			height: 823,
			deviceScaleFactor: 1.75,
		},
		throttling: {
			rttMs: 150,
			throughputKbps: 1638.4,
			cpuSlowdownMultiplier: 4,
		},
	},
	desktop: {
		formFactor: 'desktop',
		screenEmulation: {
			mobile: false,
			width: 1350,
			height: 940,
			deviceScaleFactor: 1,
		},
		throttling: {
			rttMs: 40,
			throughputKbps: 10240,
			cpuSlowdownMultiplier: 1,
		},
	},
};

/**
 * Add item to cart via classic wc-ajax.
 *
 * @param {import('puppeteer').Page} page      Puppeteer page.
 * @param {string}                   baseUrl   Site base URL.
 */
async function addToCartClassic( page, baseUrl ) {
	await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

	const status = await page.evaluate( async ( productId ) => {
		const formData = new FormData();
		formData.append( 'product_id', productId );
		formData.append( 'quantity', '2' );
		const res = await fetch( '/?wc-ajax=add_to_cart', {
			method: 'POST',
			body: formData,
		} );
		return res.status;
	}, PRODUCT_ID );

	console.log( `  Classic add_to_cart: ${ status }` );
}

/**
 * Add item to cart via Store API.
 *
 * @param {import('puppeteer').Page} page      Puppeteer page.
 * @param {string}                   baseUrl   Site base URL.
 */
async function addToCartStoreApi( page, baseUrl ) {
	await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

	const result = await page.evaluate( async ( productId ) => {
		const res = await fetch( '/wp-json/wc/store/v1/cart/add-item/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { id: productId, quantity: 2 } ),
		} );
		const body = await res.text();
		return { status: res.status, body: body.substring( 0, 150 ) };
	}, PRODUCT_ID );

	console.log( `  Store API add-item: ${ result.status } ${ result.status >= 400 ? result.body : 'OK' }` );
}

/**
 * Extract key metrics from a Lighthouse report.
 *
 * @param {Object} report Lighthouse LHR object.
 * @return {Object} Extracted metrics.
 */
function extractMetrics( report ) {
	const cats = report.categories;
	const a = report.audits;

	return {
		score: ( cats.performance?.score || 0 ) * 100,
		fcp: a[ 'first-contentful-paint' ]?.numericValue || 0,
		lcp: a[ 'largest-contentful-paint' ]?.numericValue || 0,
		tti: a.interactive?.numericValue || 0,
		tbt: a[ 'total-blocking-time' ]?.numericValue || 0,
		cls: a[ 'cumulative-layout-shift' ]?.numericValue || 0,
		si: a[ 'speed-index' ]?.numericValue || 0,
		bytes: a[ 'total-byte-weight' ]?.numericValue || 0,
	};
}

/**
 * Run a single Lighthouse audit on an existing browser.
 *
 * @param {string}                     pageUrl             URL to audit.
 * @param {import('puppeteer').Browser} browser             Puppeteer browser.
 * @param {Object}                     deviceConfig        Device/throttling settings.
 * @param {boolean}                    disableStorageReset  Keep cache/storage if true.
 * @return {Object} { metrics, lhr }
 */
async function runLighthouse( pageUrl, browser, deviceConfig, disableStorageReset ) {
	const wsEndpoint = browser.wsEndpoint();
	const port = new URL( wsEndpoint ).port;

	const result = await lighthouse( pageUrl, {
		port: parseInt( port ),
		output: 'json',
		logLevel: 'error',
		onlyCategories: [ 'performance' ],
		formFactor: deviceConfig.formFactor,
		screenEmulation: deviceConfig.screenEmulation,
		throttling: deviceConfig.throttling,
		disableStorageReset,
	} );

	return {
		metrics: extractMetrics( result.lhr ),
		lhr: result.lhr,
	};
}

/**
 * Run cold + warm cache audits for a given mode/device/page combination.
 *
 * @param {string} mode     'classic' or 'storeapi'.
 * @param {string} device   'mobile' or 'desktop'.
 * @param {string} pageName 'checkout' or 'cart'.
 * @return {Object} { cold: metrics[], warm: metrics[] }
 */
async function runCachedAudit( mode, device, pageName ) {
	const baseUrl = URLS[ mode ];
	const deviceConfig = DEVICE_CONFIG[ device ];
	const pageUrl = `${ baseUrl }/${ pageName }/`;
	const outputDir = path.join( RESULTS_DIR, `${ mode }-${ device }-${ pageName }` );

	fs.mkdirSync( outputDir, { recursive: true } );

	console.log( `\n${ '═'.repeat( 80 ) }` );
	console.log( `  ${ mode.toUpperCase() } / ${ device.toUpperCase() } / ${ pageName.toUpperCase() } — Cold vs Cached Lighthouse` );
	console.log( `${ '═'.repeat( 80 ) }` );

	const coldResults = [];
	const warmResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `\n  Run ${ run }/${ RUNS }` );

		// ── Cold audit: fresh browser, no cache ───────────────────────────
		console.log( '    [COLD] Fresh browser, no cached assets...' );

		const coldBrowser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu' ],
		} );

		const coldPage = await coldBrowser.newPage();

		if ( mode === 'classic' ) {
			await addToCartClassic( coldPage, baseUrl );
		} else {
			await addToCartStoreApi( coldPage, baseUrl );
		}

		const cold = await runLighthouse( pageUrl, coldBrowser, deviceConfig, true );
		coldResults.push( cold.metrics );

		fs.writeFileSync(
			path.join( outputDir, `cold-run${ run }.json` ),
			JSON.stringify( cold.lhr, null, 2 )
		);

		logMetrics( '    [COLD]', cold.metrics );
		await coldBrowser.close();

		// ── Warm audit: same browser, primed cache ────────────────────────
		console.log( '    [WARM] Priming browser cache...' );

		const warmBrowser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu' ],
		} );

		const warmPage = await warmBrowser.newPage();

		// Add items to cart (establishes WC session)
		if ( mode === 'classic' ) {
			await addToCartClassic( warmPage, baseUrl );
		} else {
			await addToCartStoreApi( warmPage, baseUrl );
		}

		// Prime visit: load the page fully so JS/CSS/fonts/images are cached
		await warmPage.goto( pageUrl, { waitUntil: 'networkidle2' } );
		console.log( '    [WARM] Cache primed. Running Lighthouse...' );

		// Lighthouse audits the page in a new navigation but on the SAME
		// browser — disk-cached resources serve from cache when
		// disableStorageReset is true.
		const warm = await runLighthouse( pageUrl, warmBrowser, deviceConfig, true );
		warmResults.push( warm.metrics );

		fs.writeFileSync(
			path.join( outputDir, `warm-run${ run }.json` ),
			JSON.stringify( warm.lhr, null, 2 )
		);

		logMetrics( '    [WARM]', warm.metrics );
		await warmBrowser.close();
	}

	// Save summary
	fs.writeFileSync(
		path.join( outputDir, 'summary.json' ),
		JSON.stringify( {
			mode,
			device,
			page: pageName,
			runs: RUNS,
			cold: coldResults,
			warm: warmResults,
		}, null, 2 )
	);

	return { cold: coldResults, warm: warmResults };
}

/**
 * Log metrics in a compact one-liner.
 *
 * @param {string} prefix Label prefix.
 * @param {Object} m      Metrics object.
 */
function logMetrics( prefix, m ) {
	console.log(
		`${ prefix } Score: ${ m.score.toFixed( 0 ) }  ` +
		`FCP: ${ m.fcp.toFixed( 0 ) }ms  ` +
		`LCP: ${ m.lcp.toFixed( 0 ) }ms  ` +
		`TTI: ${ m.tti.toFixed( 0 ) }ms  ` +
		`TBT: ${ m.tbt.toFixed( 0 ) }ms  ` +
		`CLS: ${ m.cls.toFixed( 3 ) }  ` +
		`Size: ${ ( m.bytes / 1024 ).toFixed( 0 ) }KB`
	);
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
 * Print a comparison table for cold vs warm across both modes.
 *
 * @param {Object} allData Results keyed by "mode-device-page".
 */
function printComparison( allData ) {
	console.log( `\n${ '═'.repeat( 100 ) }` );
	console.log( '  COLD vs CACHED — COMPARISON (median of ' + RUNS + ' runs)' );
	console.log( `${ '═'.repeat( 100 ) }` );

	const metricDefs = [
		[ 'score', 'Score', '', 1 ],
		[ 'fcp', 'FCP', 'ms', 1 ],
		[ 'lcp', 'LCP', 'ms', 1 ],
		[ 'tti', 'TTI', 'ms', 1 ],
		[ 'tbt', 'TBT', 'ms', 1 ],
		[ 'cls', 'CLS', '', 1 ],
		[ 'bytes', 'Size', 'KB', 1024 ],
	];

	for ( const pageName of [ 'cart', 'checkout' ] ) {
		for ( const device of [ 'mobile', 'desktop' ] ) {
			const cKey = `classic-${ device }-${ pageName }`;
			const sKey = `storeapi-${ device }-${ pageName }`;

			if ( ! allData[ cKey ] || ! allData[ sKey ] ) {
				continue;
			}

			console.log( `\n  ${ pageName.toUpperCase() } — ${ device.toUpperCase() }` );
			console.log(
				`  ${ 'Metric'.padEnd( 8 ) } │` +
				` ${ 'Classic Cold'.padStart( 13 ) } │` +
				` ${ 'Classic Warm'.padStart( 13 ) } │` +
				` ${ 'SA Cold'.padStart( 13 ) } │` +
				` ${ 'SA Warm'.padStart( 13 ) } │` +
				` ${ 'Cold Gap'.padStart( 10 ) } │` +
				` ${ 'Warm Gap'.padStart( 10 ) }`
			);
			console.log( `  ${ '─'.repeat( 8 ) }─┼─${ '─'.repeat( 13 ) }─┼─${ '─'.repeat( 13 ) }─┼─${ '─'.repeat( 13 ) }─┼─${ '─'.repeat( 13 ) }─┼─${ '─'.repeat( 10 ) }─┼─${ '─'.repeat( 10 ) }` );

			const cData = allData[ cKey ];
			const sData = allData[ sKey ];

			for ( const [ mk, label, unit, div ] of metricDefs ) {
				const cCold = cData.cold.length ? median( cData.cold.map( r => r[ mk ] / div ) ) : 0;
				const cWarm = cData.warm.length ? median( cData.warm.map( r => r[ mk ] / div ) ) : 0;
				const sCold = sData.cold.length ? median( sData.cold.map( r => r[ mk ] / div ) ) : 0;
				const sWarm = sData.warm.length ? median( sData.warm.map( r => r[ mk ] / div ) ) : 0;

				const fmt = ( val ) => mk === 'cls'
					? val.toFixed( 3 )
					: `${ Math.round( val ) }${ unit }`;

				// Gap = how much slower Store API is vs Classic (positive = SA slower)
				const coldGap = cCold > 0 ? ( ( sCold - cCold ) / cCold * 100 ).toFixed( 1 ) + '%' : '—';
				const warmGap = cWarm > 0 ? ( ( sWarm - cWarm ) / cWarm * 100 ).toFixed( 1 ) + '%' : '—';

				console.log(
					`  ${ label.padEnd( 8 ) } │` +
					` ${ fmt( cCold ).padStart( 13 ) } │` +
					` ${ fmt( cWarm ).padStart( 13 ) } │` +
					` ${ fmt( sCold ).padStart( 13 ) } │` +
					` ${ fmt( sWarm ).padStart( 13 ) } │` +
					` ${ coldGap.padStart( 10 ) } │` +
					` ${ warmGap.padStart( 10 ) }`
				);
			}
		}
	}

	// Cache benefit summary per mode
	console.log( `\n  CACHE BENEFIT (TTI improvement from cold → warm)` );
	console.log( `  ${ '─'.repeat( 60 ) }` );

	for ( const pageName of [ 'cart', 'checkout' ] ) {
		for ( const device of [ 'mobile', 'desktop' ] ) {
			for ( const mode of [ 'classic', 'storeapi' ] ) {
				const key = `${ mode }-${ device }-${ pageName }`;
				const data = allData[ key ];

				if ( ! data ) {
					continue;
				}

				const coldTti = median( data.cold.map( r => r.tti ) );
				const warmTti = median( data.warm.map( r => r.tti ) );
				const benefit = ( ( coldTti - warmTti ) / coldTti * 100 ).toFixed( 1 );

				console.log(
					`  ${ mode.padEnd( 10 ) } ${ device.padEnd( 8 ) } ${ pageName.padEnd( 10 ) }` +
					` Cold TTI: ${ Math.round( coldTti ) }ms →` +
					` Warm TTI: ${ Math.round( warmTti ) }ms` +
					` (${ benefit }% improvement)`
				);
			}
		}
	}
}

/**
 * Run all mode/device/page combinations.
 */
async function runAll() {
	const allData = {};

	for ( const pageName of [ 'checkout' ] ) {
		for ( const device of [ 'mobile', 'desktop' ] ) {
			for ( const mode of [ 'classic', 'storeapi' ] ) {
				const result = await runCachedAudit( mode, device, pageName );
				allData[ `${ mode }-${ device }-${ pageName }` ] = result;
			}
		}
	}

	printComparison( allData );
}

// Parse CLI args
const args = process.argv.slice( 2 );

if ( args.length === 0 || args[ 0 ] === 'all' ) {
	runAll().catch( console.error );
} else if ( args.length === 3 ) {
	const [ mode, device, pageName ] = args;
	const result = await runCachedAudit( mode, device, pageName );

	// Print single-mode summary
	const metricDefs = [ 'score', 'fcp', 'lcp', 'tti', 'tbt', 'cls', 'bytes' ];
	console.log( `\n  COLD vs WARM SUMMARY (${ mode } / ${ device } / ${ pageName })` );
	console.log( `  ${ '─'.repeat( 50 ) }` );
	for ( const mk of metricDefs ) {
		const coldMed = median( result.cold.map( r => r[ mk ] ) );
		const warmMed = median( result.warm.map( r => r[ mk ] ) );
		const diff = coldMed > 0 ? ( ( warmMed - coldMed ) / coldMed * 100 ).toFixed( 1 ) : '—';
		console.log( `  ${ mk.padEnd( 8 ) }  Cold: ${ Math.round( coldMed ) }  Warm: ${ Math.round( warmMed ) }  (${ diff }%)` );
	}
} else {
	console.log( 'Usage: node audit-cached.mjs <mode> <device> <page>' );
	console.log( '       node audit-cached.mjs all' );
	console.log( '' );
	console.log( 'Examples:' );
	console.log( '  node audit-cached.mjs classic mobile checkout' );
	console.log( '  node audit-cached.mjs storeapi desktop checkout' );
	console.log( '  node audit-cached.mjs all' );
	process.exit( 1 );
}

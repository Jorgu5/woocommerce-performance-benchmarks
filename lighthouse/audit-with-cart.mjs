/**
 * Lighthouse audit with pre-populated cart.
 *
 * Uses Puppeteer to add items to cart, then runs Lighthouse
 * on the cart/checkout page within the same browser session.
 *
 * Usage:
 *   node audit-with-cart.mjs classic mobile cart
 *   node audit-with-cart.mjs storeapi desktop checkout
 *   node audit-with-cart.mjs all  # runs all 8 combinations
 */

import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const RESULTS_DIR = path.join( __dirname, '..', 'results', 'lighthouse-with-cart' );

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

async function addToCartClassic( page, baseUrl ) {
	// Visit shop page first to init session
	await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

	// Add product via wc-ajax
	const response = await page.evaluate( async ( productId ) => {
		const formData = new FormData();
		formData.append( 'product_id', productId );
		formData.append( 'quantity', '2' );
		const res = await fetch( '/?wc-ajax=add_to_cart', {
			method: 'POST',
			body: formData,
		} );
		return res.status;
	}, PRODUCT_ID );

	console.log( `  Classic add_to_cart status: ${ response }` );
}

async function addToCartStoreApi( page, baseUrl ) {
	// Visit shop to init session
	await page.goto( `${ baseUrl }/shop/`, { waitUntil: 'networkidle2' } );

	// Add product without nonce header (nonce check disabled via mu-plugin)
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

async function runAudit( mode, device, pageName ) {
	const baseUrl = URLS[ mode ];
	const deviceConfig = DEVICE_CONFIG[ device ];
	const pageUrl = `${ baseUrl }/${ pageName }/`;
	const outputDir = path.join( RESULTS_DIR, `${ mode }-${ device }-${ pageName }` );

	fs.mkdirSync( outputDir, { recursive: true } );

	console.log( `\n═══ ${ mode.toUpperCase() } / ${ device.toUpperCase() } / ${ pageName.toUpperCase() } ═══` );
	console.log( `  URL: ${ pageUrl }` );

	const allResults = [];

	for ( let run = 1; run <= RUNS; run++ ) {
		console.log( `  Run ${ run }/${ RUNS }...` );

		// Launch fresh browser for each run
		const browser = await puppeteer.launch( {
			headless: 'new',
			args: [ '--no-sandbox', '--disable-gpu' ],
		} );

		const page = await browser.newPage();

		// Add items to cart
		if ( mode === 'classic' ) {
			await addToCartClassic( page, baseUrl );
		} else {
			await addToCartStoreApi( page, baseUrl );
		}

		// Verify cart has items
		const cartCheck = await page.evaluate( async () => {
			return document.cookie.includes( 'woocommerce_items_in_cart=1' );
		} );
		console.log( `  Cart has items: ${ cartCheck }` );

		// Get the browser's WebSocket endpoint for Lighthouse
		const wsEndpoint = browser.wsEndpoint();
		const port = new URL( wsEndpoint ).port;

		// Run Lighthouse using the existing browser (with cart session)
		const lhResult = await lighthouse( pageUrl, {
			port: parseInt( port ),
			output: 'json',
			logLevel: 'error',
			onlyCategories: [ 'performance' ],
			formFactor: deviceConfig.formFactor,
			screenEmulation: deviceConfig.screenEmulation,
			throttling: deviceConfig.throttling,
			disableStorageReset: true, // Keep cookies/session!
		} );

		const report = lhResult.lhr;
		const cats = report.categories;
		const audits = report.audits;

		const metrics = {
			score: ( cats.performance?.score || 0 ) * 100,
			fcp: audits[ 'first-contentful-paint' ]?.numericValue || 0,
			lcp: audits[ 'largest-contentful-paint' ]?.numericValue || 0,
			tti: audits.interactive?.numericValue || 0,
			tbt: audits[ 'total-blocking-time' ]?.numericValue || 0,
			cls: audits[ 'cumulative-layout-shift' ]?.numericValue || 0,
			si: audits[ 'speed-index' ]?.numericValue || 0,
			bytes: audits[ 'total-byte-weight' ]?.numericValue || 0,
		};

		console.log(
			`  Score: ${ metrics.score.toFixed( 0 ) }  ` +
			`FCP: ${ metrics.fcp.toFixed( 0 ) }ms  ` +
			`LCP: ${ metrics.lcp.toFixed( 0 ) }ms  ` +
			`TTI: ${ metrics.tti.toFixed( 0 ) }ms  ` +
			`TBT: ${ metrics.tbt.toFixed( 0 ) }ms  ` +
			`CLS: ${ metrics.cls.toFixed( 3 ) }  ` +
			`Size: ${ ( metrics.bytes / 1024 ).toFixed( 0 ) }KB`
		);

		allResults.push( metrics );

		// Save full report
		const reportPath = path.join( outputDir, `lhr-run${ run }.json` );
		fs.writeFileSync( reportPath, JSON.stringify( report, null, 2 ) );

		await browser.close();
	}

	// Save summary
	const summaryPath = path.join( outputDir, 'summary.json' );
	fs.writeFileSync( summaryPath, JSON.stringify( {
		mode, device, page: pageName,
		runs: RUNS,
		results: allResults,
	}, null, 2 ) );

	return allResults;
}

async function runAll() {
	const allData = {};

	for ( const pageName of [ 'cart', 'checkout' ] ) {
		for ( const device of [ 'mobile', 'desktop' ] ) {
			for ( const mode of [ 'classic', 'storeapi' ] ) {
				const results = await runAudit( mode, device, pageName );
				allData[ `${ mode }-${ device }-${ pageName }` ] = results;
			}
		}
	}

	// Print comparison
	console.log( '\n' + '═'.repeat( 100 ) );
	console.log( '  COMPARISON SUMMARY (median of ' + RUNS + ' runs, WITH items in cart)' );
	console.log( '═'.repeat( 100 ) );

	const med = ( arr ) => {
		const s = [ ...arr ].sort( ( a, b ) => a - b );
		const n = s.length;
		return n % 2 ? s[ Math.floor( n / 2 ) ] : ( s[ n / 2 - 1 ] + s[ n / 2 ] ) / 2;
	};

	for ( const pageName of [ 'cart', 'checkout' ] ) {
		for ( const device of [ 'mobile', 'desktop' ] ) {
			console.log( `\n  ${ pageName.toUpperCase() } — ${ device.toUpperCase() }` );
			console.log( `  ${ 'Metric'.padEnd( 8 ) } │ ${ 'Classic'.padStart( 12 ) } │ ${ 'Store API'.padStart( 12 ) } │ ${ 'Diff'.padStart( 10 ) }` );
			console.log( `  ${ '─'.repeat( 8 ) }─┼─${ '─'.repeat( 12 ) }─┼─${ '─'.repeat( 12 ) }─┼─${ '─'.repeat( 10 ) }` );

			const cKey = `classic-${ device }-${ pageName }`;
			const sKey = `storeapi-${ device }-${ pageName }`;
			const cData = allData[ cKey ] || [];
			const sData = allData[ sKey ] || [];

			for ( const [ mk, label, unit, div ] of [
				[ 'score', 'Score', '', 1 ],
				[ 'fcp', 'FCP', 'ms', 1 ],
				[ 'lcp', 'LCP', 'ms', 1 ],
				[ 'tti', 'TTI', 'ms', 1 ],
				[ 'tbt', 'TBT', 'ms', 1 ],
				[ 'cls', 'CLS', '', 1 ],
				[ 'bytes', 'Size', 'KB', 1024 ],
			] ) {
				const cMed = cData.length ? med( cData.map( r => r[ mk ] / div ) ) : 0;
				const sMed = sData.length ? med( sData.map( r => r[ mk ] / div ) ) : 0;

				const cStr = mk === 'cls'
					? cMed.toFixed( 3 )
					: `${ Math.round( cMed ) }${ unit }`;
				const sStr = mk === 'cls'
					? sMed.toFixed( 3 )
					: `${ Math.round( sMed ) }${ unit }`;

				let diff = '';
				if ( cMed > 0 ) {
					const pct = ( ( sMed - cMed ) / cMed ) * 100;
					diff = `${ pct >= 0 ? '+' : '' }${ pct.toFixed( 1 ) }%`;
				}

				console.log( `  ${ label.padEnd( 8 ) } │ ${ cStr.padStart( 12 ) } │ ${ sStr.padStart( 12 ) } │ ${ diff.padStart( 10 ) }` );
			}
		}
	}
}

// Parse CLI args
const args = process.argv.slice( 2 );

if ( args.length === 0 || args[ 0 ] === 'all' ) {
	runAll().catch( console.error );
} else if ( args.length === 3 ) {
	runAudit( args[ 0 ], args[ 1 ], args[ 2 ] ).catch( console.error );
} else {
	console.log( 'Usage: node audit-with-cart.mjs <mode> <device> <page>' );
	console.log( '       node audit-with-cart.mjs all' );
	process.exit( 1 );
}

/**
 * Lighthouse CI Configuration
 *
 * Runs Lighthouse audits on both classic and Store API instances
 * across mobile and desktop profiles.
 *
 * Usage:
 *   cd tests/performance/lighthouse
 *   MODE=classic DEVICE=mobile node run-audit.js
 *   MODE=storeapi DEVICE=desktop node run-audit.js
 *   node run-all.js  # runs all 8 combinations
 */

const CLASSIC_URL = process.env.CLASSIC_URL || 'https://classic.example.com';
const STOREAPI_URL = process.env.STOREAPI_URL || 'https://storeapi.example.com';

module.exports = {
	ci: {
		collect: {
			numberOfRuns: 5,
			settings: {
				// Chrome flags for headless
				chromeFlags: '--no-sandbox --headless',
			},
		},
		assert: {
			assertions: {
				// We're measuring, not enforcing — no assertions
			},
		},
		upload: {
			target: 'filesystem',
			outputDir: '../results/lighthouse',
		},
	},
};

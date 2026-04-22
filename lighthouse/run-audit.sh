#!/bin/bash
#
# Run Lighthouse audit for a specific mode + device + page combination.
#
# Usage:
#   ./run-audit.sh <mode> <device> <page>
#
# Examples:
#   ./run-audit.sh classic mobile cart
#   ./run-audit.sh storeapi desktop checkout
#   ./run-audit.sh classic mobile homepage
#
# Devices: mobile, desktop
# Pages: homepage, shop, cart, checkout

set -euo pipefail

MODE="${1:?Usage: ./run-audit.sh <mode> <device> <page>}"
DEVICE="${2:?Usage: ./run-audit.sh <mode> <device> <page>}"
PAGE="${3:?Usage: ./run-audit.sh <mode> <device> <page>}"

CLASSIC_URL="${CLASSIC_URL:-https://classic.example.com}"
STOREAPI_URL="${STOREAPI_URL:-https://storeapi.example.com}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/../results/lighthouse"
mkdir -p "$RESULTS_DIR"

# Select base URL
if [ "$MODE" = "classic" ]; then
  BASE_URL="$CLASSIC_URL"
elif [ "$MODE" = "storeapi" ]; then
  BASE_URL="$STOREAPI_URL"
else
  echo "Invalid mode: $MODE (use classic or storeapi)"
  exit 1
fi

# Select page URL
case "$PAGE" in
  homepage) URL="${BASE_URL}/" ;;
  shop)     URL="${BASE_URL}/shop/" ;;
  cart)     URL="${BASE_URL}/cart/" ;;
  checkout) URL="${BASE_URL}/checkout/" ;;
  *)
    echo "Invalid page: $PAGE (use homepage, shop, cart, checkout)"
    exit 1
    ;;
esac

# Build Lighthouse flags based on device
CHROME_FLAGS="--no-sandbox --headless"
if [ "$DEVICE" = "mobile" ]; then
  # Mobile: Moto G Power emulation (default Lighthouse mobile)
  PRESET="--preset=perf"
  FORM_FACTOR="--emulated-form-factor=mobile"
  THROTTLE=""
elif [ "$DEVICE" = "desktop" ]; then
  PRESET="--preset=desktop"
  FORM_FACTOR="--emulated-form-factor=desktop"
  THROTTLE=""
elif [ "$DEVICE" = "mobile-3g" ]; then
  PRESET="--preset=perf"
  FORM_FACTOR="--emulated-form-factor=mobile"
  THROTTLE="--throttling.rttMs=150 --throttling.throughputKbps=1638.4"
elif [ "$DEVICE" = "mobile-4g" ]; then
  PRESET="--preset=perf"
  FORM_FACTOR="--emulated-form-factor=mobile"
  THROTTLE="--throttling.rttMs=40 --throttling.throughputKbps=9000"
else
  echo "Invalid device: $DEVICE (use mobile, desktop, mobile-3g, mobile-4g)"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_PATH="${RESULTS_DIR}/${MODE}-${DEVICE}-${PAGE}-${TIMESTAMP}"

echo "═══════════════════════════════════════════════════"
echo "  Mode:     ${MODE}"
echo "  Device:   ${DEVICE}"
echo "  Page:     ${PAGE}"
echo "  URL:      ${URL}"
echo "  Runs:     5"
echo "  Output:   ${OUTPUT_PATH}"
echo "═══════════════════════════════════════════════════"
echo ""

# Run Lighthouse CI with 5 runs
lhci collect \
  --url="$URL" \
  --numberOfRuns=5 \
  --settings.chromeFlags="$CHROME_FLAGS" \
  --settings.output=json \
  --settings.outputPath="${OUTPUT_PATH}" \
  ${FORM_FACTOR} \
  ${THROTTLE} \
  2>&1

# Parse results and display summary
echo ""
echo "═══ Results Summary ═══"

# Find the generated JSON files and extract metrics
for JSON_FILE in .lighthouseci/lhr-*.json; do
  if [ -f "$JSON_FILE" ]; then
    python3 -c "
import json, sys
with open('$JSON_FILE') as f:
    d = json.load(f)
cat = d.get('categories', {})
aud = d.get('audits', {})
perf = cat.get('performance', {}).get('score', 0) * 100

fcp = aud.get('first-contentful-paint', {}).get('numericValue', 0)
lcp = aud.get('largest-contentful-paint', {}).get('numericValue', 0)
tti = aud.get('interactive', {}).get('numericValue', 0)
tbt = aud.get('total-blocking-time', {}).get('numericValue', 0)
cls = aud.get('cumulative-layout-shift', {}).get('numericValue', 0)
si = aud.get('speed-index', {}).get('numericValue', 0)
bytes_total = aud.get('total-byte-weight', {}).get('numericValue', 0)

print(f'  Perf: {perf:.0f}  FCP: {fcp:.0f}ms  LCP: {lcp:.0f}ms  TTI: {tti:.0f}ms  TBT: {tbt:.0f}ms  CLS: {cls:.3f}  Size: {bytes_total/1024:.0f}KB')
" 2>/dev/null
  fi
done

# Copy results to our results dir
cp .lighthouseci/lhr-*.json "$RESULTS_DIR/" 2>/dev/null
echo ""
echo "Results saved to: ${RESULTS_DIR}/"

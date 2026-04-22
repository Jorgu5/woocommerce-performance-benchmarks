#!/bin/bash
#
# Run all Lighthouse audits: classic vs storeapi × mobile vs desktop × cart + checkout
#
# This produces 8 audit sets (5 runs each = 40 Lighthouse runs total)
# Takes approximately 15-20 minutes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  Lighthouse CI — Full Audit Suite                        ║"
echo "║  8 combinations × 5 runs = 40 total Lighthouse audits    ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

for PAGE in cart checkout; do
  for DEVICE in mobile desktop; do
    for MODE in classic storeapi; do
      echo ""
      echo "$(date +%H:%M:%S) ─── ${MODE} / ${DEVICE} / ${PAGE} ───"
      bash "${SCRIPT_DIR}/run-audit.sh" "$MODE" "$DEVICE" "$PAGE"
      sleep 3
    done
  done
done

echo ""
echo "$(date +%H:%M:%S) ═══ ALL AUDITS COMPLETE ═══"
echo ""

# Generate comparison summary
echo "Generating comparison summary..."
python3 "${SCRIPT_DIR}/compare-results.py" 2>/dev/null || echo "Run compare-results.py manually to see the comparison."

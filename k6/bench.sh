#!/bin/bash
#
# Run a specific benchmark scenario + profile combination.
#
# Usage:
#   ./bench.sh <mode> <scenario> <profile>
#
# Examples:
#   ./bench.sh classic s1 baseline
#   ./bench.sh storeapi s6 heavy
#   ./bench.sh classic s7 medium
#
# Results are saved to ../results/<mode>-<scenario>-<profile>.json

set -euo pipefail

MODE="${1:?Usage: ./bench.sh <mode> <scenario> <profile>}"
SCENARIO="${2:?Usage: ./bench.sh <mode> <scenario> <profile>}"
PROFILE="${3:?Usage: ./bench.sh <mode> <scenario> <profile>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/../results"
mkdir -p "$RESULTS_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="${RESULTS_DIR}/${MODE}-${SCENARIO}-${PROFILE}-${TIMESTAMP}.json"

echo "═══════════════════════════════════════════════════"
echo "  Mode:     ${MODE}"
echo "  Scenario: ${SCENARIO}"
echo "  Profile:  ${PROFILE}"
echo "  Output:   ${OUTPUT_FILE}"
echo "═══════════════════════════════════════════════════"
echo ""

k6 run \
  -e "MODE=${MODE}" \
  -e "SCENARIO=${SCENARIO}" \
  -e "PROFILE=${PROFILE}" \
  --summary-export="${OUTPUT_FILE}" \
  "${SCRIPT_DIR}/run.js"

echo ""
echo "Results saved to: ${OUTPUT_FILE}"

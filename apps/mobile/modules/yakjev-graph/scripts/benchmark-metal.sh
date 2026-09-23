#!/usr/bin/env bash
set -euo pipefail

module_dir="$(cd "$(dirname "$0")/.." && pwd)"
# Opt-in offscreen host GPU measurement; the output explicitly excludes labels,
# React Native, display presentation, and any iPhone frame-rate guarantee.
YAKJEV_METAL_BENCHMARK=1 swift test \
  -c release \
  --package-path "$module_dir" \
  --filter GraphMetalTests.testLargeGraphMetalBenchmark

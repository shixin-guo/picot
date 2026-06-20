#!/bin/bash

echo "Running lint:fix → format:fix → check sequentially..."
echo ""

run_step() {
  local name="$1"
  shift
  echo "[$name] Starting..."
  if "$@"; then
    echo "[$name] ✓ Completed successfully"
    echo ""
  else
    echo ""
    echo "[$name] ✗ Failed"
    exit 1
  fi
}

run_step "lint:fix"   bun run lint:fix
run_step "format:fix" bun run format:fix
run_step "check"      bun run check

echo "✓ All tasks completed successfully!"

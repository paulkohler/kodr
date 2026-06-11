#!/bin/bash
# Quick kodr test run — one-shot prompt against local LM Studio
set -e

# Create a temporary test workspace
WORKDIR=$(mktemp -d /tmp/kodr-test-XXXX)
echo "==> Test workspace: $WORKDIR"

cat > "$WORKDIR/hello.mjs" << 'EOF'
// A simple greeting module
export function greet(name) {
  return `Hello, ${name}!`;
}

console.log(greet("World"));
EOF

cat > "$WORKDIR/README.md" << 'EOF'
# Hello

A simple greeting app.
EOF

cd "$WORKDIR"

echo "==> Running kodr probe..."
node ~/src/koder-by-codex/bin/kodr.mjs probe --json 2>&1 || true

echo ""
echo "==> Running kodr one-shot..."
node ~/src/koder-by-codex/bin/kodr.mjs run \
  -p "Add a farewell function to hello.mjs that says goodbye to the given name, and call it after greet." \
  --yes \
  --out kodr-output \
  --json \
  --no-tools \
  --timeout-ms 120000 \
  2>&1

echo ""
echo "==> Run complete. Artifacts in: $WORKDIR/kodr-output/"
echo "==> Listing artifacts:"
ls -la "$WORKDIR/kodr-output/" 2>/dev/null || echo "(no output dir)"

echo ""
echo "==> Summary:"
cat "$WORKDIR/kodr-output/summary.json" 2>/dev/null | python3 -m json.tool || echo "(no summary)"

echo ""
echo "==> Response:"
cat "$WORKDIR/kodr-output/response.md" 2>/dev/null || echo "(no response)"

echo ""
echo "==> Writes:"
cat "$WORKDIR/kodr-output/writes.json" 2>/dev/null | python3 -m json.tool || echo "(no writes)"

echo ""
echo "==> Modified file:"
cat "$WORKDIR/hello.mjs"

echo ""
echo "==> Diagnostics:"
cat "$WORKDIR/kodr-output/diagnostics.json" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "null"

echo ""
echo "==> Harness manifest (from summary):"
cat "$WORKDIR/kodr-output/summary.json" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('harness',{}),indent=2))" 2>/dev/null || echo "(none)"

# Copy full output for inspection
cp -r "$WORKDIR" ~/src/koder-by-codex/.kodr-test-output 2>/dev/null || true
echo ""
echo "==> Full output also at: ~/src/koder-by-codex/.kodr-test-output/"
echo "==> DONE"

#!/usr/bin/env bash
#
# Startup latency benchmarks for y2.
#
# Measures wall-clock time for common CLI commands using hyperfine.
# Results are written to benchmarks/results/ in JSON format for CI consumption.
#
# Usage:
#   ./benchmarks/startup.sh              # run all benchmarks
#   ./benchmarks/startup.sh --quick      # fewer iterations (20 runs)
#   ./benchmarks/startup.sh --ci         # CI settings (100 runs, skip build)
#
# Requires: hyperfine (https://github.com/sharkdp/hyperfine)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
Y2_BIN="${REPO_ROOT}/zig-out/bin/y2"
RESULTS_DIR="${REPO_ROOT}/benchmarks/results"
SESSION_FIXTURE_ROOT="${TMPDIR:-/tmp}/y2-session-list-benchmark-$$"
SESSION_FIXTURE_HOME="${SESSION_FIXTURE_ROOT}/home"
SESSION_FIXTURE_WORKSPACE="${SESSION_FIXTURE_ROOT}/workspace"
GENERAL_FIXTURE_HOME="${SESSION_FIXTURE_ROOT}/general-home"

cleanup() {
  rm -rf "$SESSION_FIXTURE_ROOT"
}
trap cleanup EXIT

if ! command -v hyperfine &>/dev/null; then
  echo "error: hyperfine is not installed"
  echo "       brew install hyperfine  (macOS)"
  echo "       apt install hyperfine   (Debian/Ubuntu)"
  echo "       cargo install hyperfine (Rust/Cargo)"
  exit 1
fi

RUNS=100
WARMUP=10
SKIP_BUILD=false
SHELL_OPTS=(-N)
case "${1:-}" in
  --quick)  RUNS=20;  WARMUP=3 ;;
  --ci)     RUNS=100; WARMUP=10; SKIP_BUILD=true ;;
esac

if [ "$SKIP_BUILD" = false ]; then
  echo "Building y2 (ReleaseSafe)..."
  (cd "$REPO_ROOT" && zig build -Doptimize=ReleaseSafe)
fi

if [ ! -x "$Y2_BIN" ]; then
  echo "error: y2 binary not found at $Y2_BIN"
  exit 1
fi

mkdir -p "$RESULTS_DIR"
rm -f "${RESULTS_DIR}/tasks.json"
mkdir -p "$SESSION_FIXTURE_HOME" "$SESSION_FIXTURE_WORKSPACE" "$GENERAL_FIXTURE_HOME"
mkdir -p "$GENERAL_FIXTURE_HOME/.y2"
chmod 700 "$GENERAL_FIXTURE_HOME/.y2"
printf '%s\n' \
  '{"model":"openai/gpt-5.4","effort":"high","fast_mode":false,"startup_scrollback":true,"prompt_history":{"enabled":true},"statusLine":{"sandbox":true,"context":true},"permission":{"bash":{"git status *":"allow"}}}' \
  > "$GENERAL_FIXTURE_HOME/.y2/settings.json"
chmod 600 "$GENERAL_FIXTURE_HOME/.y2/settings.json"
python3 "${REPO_ROOT}/benchmarks/session_list_fixture.py" \
  --home "$SESSION_FIXTURE_HOME" \
  --workspace "$SESSION_FIXTURE_WORKSPACE"

if [ -x /usr/bin/true ]; then
  TRUE_BIN=/usr/bin/true
elif [ -x /bin/true ]; then
  TRUE_BIN=/bin/true
else
  TRUE_BIN=true
fi

echo "=== y2 startup benchmarks ==="
echo "binary: $Y2_BIN"
echo "runs:   $RUNS (warmup: $WARMUP)"
echo ""

# Baseline: process launch floor on this host. This is reported for context;
# the budget checker still enforces each y2 command's raw wall-clock mean.
echo "--- process baseline ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/baseline.json" \
  --command-name "process baseline" \
  "$TRUE_BIN"

echo ""

# Benchmark 0: y2 startup (CLI dispatch, no TTY needed)
echo "--- y2 (startup) ---"
HOME="$GENERAL_FIXTURE_HOME" Y2_BENCH=1 hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/startup.json" \
  --command-name "y2 (startup)" \
  "$Y2_BIN"

echo ""

# Benchmark 1: y2 help (minimal startup path)
echo "--- y2 help ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/help.json" \
  --command-name "y2 help" \
  "$Y2_BIN help"

echo ""

# Benchmark 2: y2 status --json (config load + JSON serialize)
echo "--- y2 status --json ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/status.json" \
  --command-name "y2 status --json" \
  "$Y2_BIN status --json"

echo ""

# Benchmark 3: y2 doctor --json (system checks)
echo "--- y2 doctor --json ---"
HOME="$GENERAL_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/doctor.json" \
  --command-name "y2 doctor --json" \
  "$Y2_BIN doctor --json"

echo ""

# Benchmark 4: y2 sessions --json (file I/O path)
echo "--- y2 sessions --json ---"
HOME="$SESSION_FIXTURE_HOME" hyperfine \
  "${SHELL_OPTS[@]}" \
  --runs "$RUNS" \
  --warmup "$WARMUP" \
  --export-json "${RESULTS_DIR}/sessions.json" \
  --command-name "y2 sessions --json" \
  "$Y2_BIN sessions --json"

echo ""

# Benchmark 5: y2 background --json (file I/O path)
echo "--- y2 background --json ---"
(
  cd "$SESSION_FIXTURE_WORKSPACE"
  HOME="$SESSION_FIXTURE_HOME" hyperfine \
    "${SHELL_OPTS[@]}" \
    --runs "$RUNS" \
    --warmup "$WARMUP" \
    --export-json "${RESULTS_DIR}/background.json" \
    --command-name "y2 background --json" \
    "$Y2_BIN background --json"
)

echo ""

# Combine results into a single summary for CI
echo "--- summary ---"
python3 "${REPO_ROOT}/benchmarks/summarize.py"
python3 "${REPO_ROOT}/benchmarks/check_budgets.py"

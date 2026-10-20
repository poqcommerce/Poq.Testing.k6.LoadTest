#!/usr/bin/env bash
# Pacsun: one command for the sanity, warm-up and load (scale) runs on pacsun-perf.
# It only builds the plain `k6 run` command (shown before it runs) and names the output files.
#
#   clients/pacsun/scripts/run.sh <sanity|warmup|load> --env <prod|dev> [--max-data-age <hours>] [--clear-vouchers] [--prom] [--save-output] [--yes] [--dry-run] [-- extra k6 args]
#
#   sanity   1% of the target, 5 min,  about 1,600 requests, 1 registration   (abort check after 60 s)
#   warmup   10% of the target, 15 min, about 50,000 requests, 5 registrations (abort check after 90 s)
#   load     the full scale shape (PROFILE=scale), 30 min, about 1M requests, 50 registrations (abort check after 3 min)
#
# --env prod is the isolated pacsun-perf client on the platform host (prod guards apply).
# --max-data-age 200 overrides the 12 h data limit (pacsun-perf stock does not change; MAX_DATA_AGE_HOURS=200 works too).
# --clear-vouchers first runs prep/clear-vouchers.mjs, which removes vouchers left on the test accounts' bags.
# --prom also streams the metrics to Prometheus for the Grafana dashboard (PROM_URL overrides the default
# http://localhost:9090/api/v1/write). The run is tagged testid=<run folder name> to pick it in Grafana.
# --save-output also keeps k6's console output in results/<run>/output.txt.
# Every run gets its own folder, results/pacsun_<env>_<profile>_<timestamp>/, holding report.html, failures.log,
# summary.json, endpoints.csv, endpoints.html and failures.csv (RUN_DIR tells the test where to write its files).
# Live dashboards on a VM (open an SSH tunnel first): k6 http://localhost:5665, Grafana http://localhost:3000
#   ssh -N -L 5665:localhost:5665 -L 3000:localhost:3000 <vm>

set -euo pipefail
cd "$(dirname "$0")/../../.."  # the project root, wherever the script is started from

usage() { awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit "${1:-1}"; }

ENV_NAME=""  # no default: the target is always chosen explicitly
MAX_AGE="${MAX_DATA_AGE_HOURS:-}"
CLEAR_VOUCHERS=false
SAVE_OUTPUT=false
PROM=false
ASSUME_YES=false
DRY_RUN=false
CHOICE=""
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    sanity|warmup|load|scale) CHOICE="$1" ;;
    --env) ENV_NAME="${2:?--env needs a value}"; shift ;;
    --max-data-age) MAX_AGE="${2:?--max-data-age needs a number of hours}"; shift ;;
    MAX_DATA_AGE_HOURS=*) MAX_AGE="${1#*=}" ;;
    --clear-vouchers) CLEAR_VOUCHERS=true ;;
    --save-output) SAVE_OUTPUT=true ;;
    --prom) PROM=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
  shift
done
[ -n "$CHOICE" ] || usage
case "$ENV_NAME" in prod|dev) ;; "") echo "--env is required (prod or dev)" >&2; usage ;; *) echo "--env must be prod or dev, got: $ENV_NAME" >&2; exit 1 ;; esac

case "$CHOICE" in
  sanity) K6_PROFILE=sanity; ABORT_DELAY=60s; SIZE="about 1,600 requests over 5 min"; REGISTERS=1 ;;
  warmup) K6_PROFILE=warmup; ABORT_DELAY=90s; SIZE="about 50,000 requests over 15 min"; REGISTERS=5 ;;
  load|scale) K6_PROFILE=scale; ABORT_DELAY=3m; SIZE="about 1M requests over 30 min (585 req/s at hold)"; REGISTERS=50 ;;
esac

case "$MAX_AGE" in ''|*[!0-9.]*) [ -z "$MAX_AGE" ] || { echo "--max-data-age must be a number of hours, got: $MAX_AGE" >&2; exit 1; } ;; esac
command -v k6 >/dev/null || { echo "k6 is not installed or not on PATH" >&2; exit 1; }
[ -f "clients/pacsun/data/products_${ENV_NAME}.json" ] || { echo "Missing clients/pacsun/data/products_${ENV_NAME}.json (validate or copy it first)" >&2; exit 1; }
[ -f "clients/pacsun/data/accounts_${ENV_NAME}.json" ] || { echo "Missing clients/pacsun/data/accounts_${ENV_NAME}.json (the logged-in checkout needs it)" >&2; exit 1; }
RUN="pacsun_${ENV_NAME}_${CHOICE}_$(date +%Y%m%d-%H%M%S)"
RUN_DIR="results/${RUN}"

CMD=(k6 run
  -e "ENV=${ENV_NAME}"
  -e "PROFILE=${K6_PROFILE}"
  -e "ABORT_DELAY=${ABORT_DELAY}"
  -e "RUN_DIR=${RUN_DIR}"
  --log-format raw
  --console-output "${RUN_DIR}/failures.log")
[ "$ENV_NAME" = prod ] && CMD+=(-e ALLOW_PROD=true)
[ -n "$MAX_AGE" ] && CMD+=(-e "MAX_DATA_AGE_HOURS=${MAX_AGE}")
[ ${#EXTRA[@]} -gt 0 ] && CMD+=("${EXTRA[@]}")
if $PROM; then
  # No `url` system tag: the request `name` tag is the per-endpoint label, and url would add one label value per product.
  # `check` stays, or the dashboard's checks list is empty.
  CMD+=(-o experimental-prometheus-rw
    --system-tags=proto,subproto,status,method,scenario,expected_response,error,error_code,tls_version,group,check
    --tag "testid=${RUN}")
  export K6_PROMETHEUS_RW_SERVER_URL="${PROM_URL:-http://localhost:9090/api/v1/write}"
  export K6_PROMETHEUS_RW_TREND_STATS="avg,p(95),p(99),max"
fi
CMD+=(clients/pacsun/test.js)

CLEAR=(node prep/clear-vouchers.mjs pacsun --env "$ENV_NAME" --max-rpm 300)
[ "$ENV_NAME" = prod ] && CLEAR+=(--allow-prod)

export K6_WEB_DASHBOARD=true
export K6_WEB_DASHBOARD_PORT=5665
export K6_WEB_DASHBOARD_EXPORT="${RUN_DIR}/report.html"

echo "Pacsun ${CHOICE} on ${ENV_NAME}: ${SIZE}"
# sanity, warmup and scale add the fixed-count register scenario unless SCENARIOS is passed after --
echo "Creates about ${REGISTERS} real account(s) (register scenario) that cannot be deleted."
if $CLEAR_VOUCHERS; then echo "First:"; printf '  '; printf '%q ' "${CLEAR[@]}"; echo; fi
echo "Command:"
printf '  K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_PORT=5665 K6_WEB_DASHBOARD_EXPORT=%q \\\n' "$K6_WEB_DASHBOARD_EXPORT"
$PROM && printf '  K6_PROMETHEUS_RW_SERVER_URL=%q \\\n' "$K6_PROMETHEUS_RW_SERVER_URL"
printf '  '; printf '%q ' "${CMD[@]}"; echo
echo

if $DRY_RUN; then echo "(dry run: nothing was sent)"; exit 0; fi

if [ "$ENV_NAME" = prod ] && ! $ASSUME_YES; then
  echo "This sends real traffic to pacsun-perf on the PROD host and creates about ${REGISTERS} account(s)."
  read -r -p "Type PROD to continue: " ANSWER
  [ "$ANSWER" = PROD ] || { echo "Cancelled."; exit 1; }
fi

if $CLEAR_VOUCHERS; then
  "${CLEAR[@]}" || { echo "clear-vouchers failed; not starting the run" >&2; exit 1; }
  echo
fi

mkdir -p "$RUN_DIR"
echo "Dashboard: http://localhost:5665 (through your SSH tunnel)   Report: ${RUN_DIR}/report.html"
set +e
if $SAVE_OUTPUT; then
  "${CMD[@]}" 2>&1 | tee "${RUN_DIR}/output.txt"
  STATUS=${PIPESTATUS[0]}
else
  "${CMD[@]}"
  STATUS=$?
fi
set -e

echo
echo "k6 exit code: ${STATUS} (0 = thresholds passed, 99 = thresholds breached, 108 = aborted)"
echo "Files: ${RUN_DIR}/"
exit "$STATUS"

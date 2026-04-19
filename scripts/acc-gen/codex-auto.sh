#!/bin/bash

# Codex OAuth Auto - Batch account authorization
# Usage:
#   codex-auto.sh [--all | --index N] [--accounts-file FILE] [--signup] \
#                 [--proxy-file FILE] [--proxy-scheme SCHEME] [--max-proxy-attempts N] \
#                 [--env-file FILE] [--no-env-file] \
#                 [--browser-engine auto|puppeteer|playwright] \
#                 [--state-file FILE] [--used-file FILE] [--no-skip-existing-auth] \
#                 [--resume] [--reset-state] [--names-file FILE] \
#                 [--sms-services CSV] [--sms-service-prefix PREFIX] [--sms-service-query TEXT] \
#                 [--sms-price-ranking MODE] [--list-sms-services]
#   --all                  : Process all accounts in accounts file (.json or text)
#   --index N              : Process only account at index N (0-based)
#   --proxy-file FILE      : One proxy per line (supports host:port@user:pass and user:pass@host:port)
#   --proxy-scheme SCHEME  : http|https|socks5|socks4 (default: socks5)
#   --max-proxy-attempts N : Max proxy attempts per account when proxy file is set (default: 3)
#   --proxy-cooldown-file F: JSON file with proxy phone-step cooldown state
#   --env-file FILE        : Load env profile from FILE (KEY=VALUE lines)
#   --no-env-file          : Disable automatic env profile discovery
#   --browser-engine       : Browser launcher preference (default: auto)
#   --state-file FILE      : JSON state file for progress tracking/resume
#   --used-file FILE       : Flat-file registry for successful/used accounts
#   --no-skip-existing-auth: Disable skip for accounts that already have auth file
#   --resume               : Skip accounts already marked success in state file
#   --reset-state          : Reset state file before run
#   --names-file FILE      : Full-name list for about-you step (First Last per line)
#   --sms-services CSV     : SMS service codes (comma-separated), supports wildcard entries like op*
#   --sms-service-prefix X : Prefix filter for SMS service codes
#   --sms-service-query X  : Search in SMS service code/name (if omitted, codex-login default applies)
#   --sms-price-ranking X  : off (default) | price_asc
#   --list-sms-services    : Print available services (respects prefix/query) and exit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
LOADED_ENV_FILE=""
ENV_FILE_CLI=""
NO_AUTO_ENV_FILE=false
RUN_LOCK_FILE="${CODEX_RUN_LOCK_FILE:-$RUNTIME_DIR/acc-gen/codex-auto.lock}"
RUN_LOCK_FD=""

load_env_file() {
    local env_file="$1"
    local load_rc=0
    if [ -z "$env_file" ]; then
        echo "Error: empty env file path"
        exit 1
    fi
    if [[ "$env_file" != /* ]]; then
        env_file="$PWD/$env_file"
    fi
    if [ ! -f "$env_file" ]; then
        echo "Error: env file not found at $env_file"
        exit 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$env_file" || load_rc=$?
    set +a
    if [ "$load_rc" -ne 0 ]; then
        echo "Error: failed to load env file $env_file"
        exit 1
    fi
    LOADED_ENV_FILE="$env_file"
}

have_rg() {
    command -v rg >/dev/null 2>&1
}

bootstrap_env_args() {
    local args=("$@")
    local i=0
    while [ "$i" -lt "${#args[@]}" ]; do
        case "${args[$i]}" in
            --env-file)
                i=$((i + 1))
                if [ "$i" -ge "${#args[@]}" ] || [ -z "${args[$i]}" ]; then
                    echo "Error: --env-file requires a path"
                    exit 1
                fi
                ENV_FILE_CLI="${args[$i]}"
                ;;
            --env-file=*)
                ENV_FILE_CLI="${args[$i]#--env-file=}"
                if [ -z "$ENV_FILE_CLI" ]; then
                    echo "Error: --env-file requires a path"
                    exit 1
                fi
                ;;
            --no-env-file)
                NO_AUTO_ENV_FILE=true
                ;;
        esac
        i=$((i + 1))
    done
}

bootstrap_env_args "$@"
if [ -n "$ENV_FILE_CLI" ]; then
    load_env_file "$ENV_FILE_CLI"
elif [ -n "${CODEX_AUTO_ENV_FILE:-}" ]; then
    load_env_file "$CODEX_AUTO_ENV_FILE"
elif [ "$NO_AUTO_ENV_FILE" != true ]; then
    for default_env_file in \
        "$SCRIPT_DIR/codex-auto.env" \
        "$RUNTIME_DIR/acc-gen/codex-auto.env" \
        "$PROJECT_DIR/.codex-auto.env"; do
        if [ -f "$default_env_file" ]; then
            load_env_file "$default_env_file"
            break
        fi
    done
fi

CLI_BINARY="$PROJECT_DIR/cli-proxy-api"
CLI_WORKDIR="$PROJECT_DIR"
RUN_TAG="${CODEX_RUN_TAG:-$$}"
ACCOUNTS_FILE="${CODEX_ACCOUNTS_FILE:-$SCRIPT_DIR/accounts.json}"
PREPARED_ACCOUNTS_FILE=""
TEMP_PREPARED_ACCOUNTS=false
PREPARED_ACCOUNTS_CACHE_DIR="${CODEX_PREPARED_ACCOUNTS_CACHE_DIR:-/tmp/codex-accounts-cache}"
NAMES_FILE="${CODEX_NAMES_FILE:-}"
CURRENT_AUTH_LOG=""
CLI_AUTH_PID=""
CLI_AUTH_OUT_FD=""
CLI_AUTH_IN_FD=""
CLI_AUTH_READER_PID=""
PROXY_COOLDOWN_FILE="${CODEX_PROXY_COOLDOWN_FILE:-$RUNTIME_DIR/acc-gen/codex-proxy-cooldown.json}"
PROXY_PHONE_COOLDOWN_FIRST_SEC="${CODEX_PROXY_PHONE_COOLDOWN_FIRST_SEC:-300}"
PROXY_PHONE_COOLDOWN_SECOND_SEC="${CODEX_PROXY_PHONE_COOLDOWN_SECOND_SEC:-600}"

if [ ! -f "$CLI_BINARY" ] && [ -f "$RUNTIME_DIR/cli-proxy-api" ]; then
    CLI_BINARY="$RUNTIME_DIR/cli-proxy-api"
fi

if [ -f "$RUNTIME_DIR/config.yaml" ]; then
    CLI_WORKDIR="$RUNTIME_DIR"
elif [ -f "$PROJECT_DIR/config.yaml" ]; then
    CLI_WORKDIR="$PROJECT_DIR"
fi

if [ ! -f "$ACCOUNTS_FILE" ] && [ -f "$RUNTIME_DIR/acc-gen/accounts.json" ]; then
    ACCOUNTS_FILE="$RUNTIME_DIR/acc-gen/accounts.json"
fi

if [ -z "$NAMES_FILE" ]; then
    if [ -f "$SCRIPT_DIR/qwen-safe-names.txt" ]; then
        NAMES_FILE="$SCRIPT_DIR/qwen-safe-names.txt"
    elif [ -f "$RUNTIME_DIR/acc-gen/qwen-safe-names.txt" ]; then
        NAMES_FILE="$RUNTIME_DIR/acc-gen/qwen-safe-names.txt"
    fi
fi

extract_auth_url() {
    local raw url
    raw="$(printf '%s' "$1" | tr -d '\r')"
    url="$(printf '%s\n' "$raw" | grep -oiP 'https://auth\.openai\.com/oauth/authorize\?[^\s"<>]+' | head -n 1)"
    url="$(printf '%s' "$url" | sed -E 's/(Waiting.*|Paste the Codex callback URL.*)$//' | sed -E 's/[[:space:]]+$//')"
    printf '%s\n' "$url"
}

extract_callback_url() {
    local input="$1"
    local callback_url=""

    callback_url="$(printf '%s\n' "$input" | grep -oP '^CALLBACK:\K.*' | tail -n 1)"
    if [ -z "$callback_url" ]; then
        callback_url="$(printf '%s\n' "$input" | grep -oP 'http://localhost:1455/auth/callback[^\s"]*' | tail -n 1)"
    fi

    callback_url="$(printf '%s' "$callback_url" | sed -E 's/Waiting.*$//' | sed -E 's/[[:space:]]+$//')"
    printf '%s\n' "$callback_url"
}

submit_callback_via_prompt() {
    local callback_url="$1"

    if [ -z "$callback_url" ]; then
        echo "[callback-debug] submit_callback_via_prompt: empty callback URL"
        return 1
    fi
    if [ -z "${CLI_AUTH_IN_FD:-}" ] || [ -z "${CLI_AUTH_PID:-}" ]; then
        echo "[callback-debug] submit_callback_via_prompt: cliproxyapi stdin is unavailable"
        return 1
    fi

    if [ -n "${CURRENT_AUTH_LOG:-}" ] && [ -f "$CURRENT_AUTH_LOG" ]; then
        echo "[callback-debug] log tail before stdin callback submit:"
        tail -8 "$CURRENT_AUTH_LOG" 2>/dev/null || true
    fi
    echo "[callback-debug] sending callback to cliproxyapi stdin"
    if ! printf '%s\n' "$callback_url" >&"${CLI_AUTH_IN_FD}"; then
        echo "[callback-debug] failed to write callback to cliproxyapi stdin"
        return 1
    fi

    sleep 1
    if [ -n "${CURRENT_AUTH_LOG:-}" ] && [ -f "$CURRENT_AUTH_LOG" ]; then
        echo "[callback-debug] log tail after prompt send:"
        tail -12 "$CURRENT_AUTH_LOG" 2>/dev/null || true
    fi
    return 0
}

auth_log_has_success() {
    [ -n "${CURRENT_AUTH_LOG:-}" ] && [ -f "$CURRENT_AUTH_LOG" ] && grep -qi "successful\|saved to\|Authentication saved" "$CURRENT_AUTH_LOG" 2>/dev/null
}

callback_was_delivered_locally() {
    local login_log="$1"
    [ -n "$login_log" ] && [ -f "$login_log" ] && grep -q 'Local redirect without code: http://localhost:1455/success' "$login_log" 2>/dev/null
}

find_codex_auth_file_for_email() {
    local email="$1"
    find "$CLI_WORKDIR/auth" -maxdepth 1 -type f -name "codex-*${email}*.json" 2>/dev/null | head -n 1
}

stream_cli_auth_output() {
    local fd="$1"
    local log_path="$2"
    local line=""

    while IFS= read -r -u "$fd" line; do
        printf '%s\n' "$line" | tee -a "$log_path"
    done
}

start_cli_auth() {
    local log_path="$1"
    : > "$log_path"
    script -qefc "cd \"$CLI_WORKDIR\" && exec \"$CLI_BINARY\" --codex-login --no-browser" /dev/null >>"$log_path" 2>&1 &
    CLI_AUTH_PID=$!
    CLI_AUTH_OUT_FD=""
    CLI_AUTH_IN_FD=""
    CLI_AUTH_READER_PID=""
}

stop_cli_auth() {
    local cli_pid="${CLI_AUTH_PID:-}"

    if [ -n "$cli_pid" ]; then
        kill "$cli_pid" 2>/dev/null || true
        wait "$cli_pid" 2>/dev/null || true
    fi

    CLI_AUTH_PID=""
    CLI_AUTH_OUT_FD=""
    CLI_AUTH_IN_FD=""
    CLI_AUTH_READER_PID=""
}

list_port_1455_listener_pids() {
    if have_rg; then
        ss -ltnp 2>/dev/null \
            | rg ':1455 ' \
            | rg -o 'pid=[0-9]+' \
            | cut -d= -f2 \
            | sort -u
        return 0
    fi

    ss -ltnp 2>/dev/null \
        | grep ':1455 ' \
        | grep -o 'pid=[0-9]\+' \
        | cut -d= -f2 \
        | sort -u
}

kill_pid_soft_then_hard() {
    local pid="$1"
    local i=0

    if [ -z "$pid" ]; then
        return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi

    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 8); do
        if ! kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.25
    done

    kill -9 "$pid" 2>/dev/null || true
}

kill_stray_cli_auth_processes() {
    local pids pid
    pids="$(pgrep -f '[c]li-proxy-api --codex-login --no-browser' 2>/dev/null || true)"
    if [ -z "$pids" ]; then
        return 0
    fi

    echo "[callback-debug] cleaning stray cli-proxy-api auth process(es): $(echo "$pids" | tr '\n' ' ')"
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        kill_pid_soft_then_hard "$pid"
    done <<EOF
$pids
EOF
}

kill_stray_login_node_processes() {
    local pids pid
    pids="$(pgrep -f 'node .*/scripts/acc-gen/codex-login\.js' 2>/dev/null || true)"
    if [ -z "$pids" ]; then
        return 0
    fi

    echo "[callback-debug] cleaning stray codex-login node process(es): $(echo "$pids" | tr '\n' ' ')"
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        kill_pid_soft_then_hard "$pid"
    done <<EOF
$pids
EOF
}

kill_port_1455_listener() {
    local pids pid
    pids="$(list_port_1455_listener_pids || true)"
    if [ -z "$pids" ]; then
        return 0
    fi

    echo "[callback-debug] cleaning port 1455 listener PID(s): $(echo "$pids" | tr '\n' ' ')"
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        kill_pid_soft_then_hard "$pid"
    done <<EOF
$pids
EOF
}

ensure_clean_auth_env() {
    stop_cli_auth
    kill_stray_login_node_processes
    kill_stray_cli_auth_processes
    kill_port_1455_listener
}

acquire_run_lock() {
    mkdir -p "$(dirname "$RUN_LOCK_FILE")"
    if ! command -v flock >/dev/null 2>&1; then
        echo "Warning: flock is not available; single-run lock is disabled"
        return 0
    fi

    exec {RUN_LOCK_FD}>"$RUN_LOCK_FILE"
    if ! flock -n "$RUN_LOCK_FD"; then
        echo "Error: another codex-auto.sh run is already active (lock: $RUN_LOCK_FILE)"
        echo "Stop previous batch before starting a new one."
        exit 1
    fi
}

start_cli_auth_with_recover() {
    local log_path="$1"
    local startup_attempt=0

    for startup_attempt in 1 2 3; do
        if ss -ltn 2>/dev/null | grep -q ':1455 '; then
            echo "[callback-debug] port 1455 busy before startup attempt ${startup_attempt}; cleaning listener"
            kill_port_1455_listener
            sleep 1
        fi

        start_cli_auth "$log_path"
        sleep 1

        if [ -f "$log_path" ] && grep -qi 'port_in_use: OAuth callback port is already in use' "$log_path"; then
            echo "[callback-debug] port_in_use detected on startup attempt ${startup_attempt}; restarting auth process"
            ensure_clean_auth_env
            sleep 1
            continue
        fi

        return 0
    done

    return 1
}

# Parse arguments
PROCESS_ALL=false
ACCOUNT_INDEX=0
FORCE_SIGNUP=false
FORCE_SIGNUP_DEFAULT="${CODEX_FORCE_SIGNUP:-0}"
PROXY_FILE="${CODEX_PROXY_FILE:-}"
PROXY_SCHEME="${CODEX_PROXY_SCHEME:-socks5}"
MAX_PROXY_ATTEMPTS="${CODEX_MAX_PROXY_ATTEMPTS:-3}"
POST_CALLBACK_WAIT_SECONDS="${CODEX_POST_CALLBACK_WAIT_SECONDS:-125}"
AUTO_SIGNUP_ON_LOGIN_FAIL="${CODEX_AUTO_SIGNUP_ON_LOGIN_FAIL:-1}"
BROWSER_ENGINE="${CODEX_BROWSER_ENGINE:-auto}"
STATE_FILE="${CODEX_STATE_FILE:-$SCRIPT_DIR/codex-auto-state.json}"
USED_ACCOUNTS_FILE="${CODEX_USED_ACCOUNTS_FILE:-$RUNTIME_DIR/acc-gen/codex-used-accounts.log}"
SKIP_EXISTING_AUTH=true
RESUME_MODE=false
RESET_STATE=false
SMS_SERVICES="${HERO_SMS_SERVICES:-}"
SMS_SERVICE_PREFIX="${HERO_SMS_SERVICE_PREFIX:-}"
SMS_SERVICE_QUERY="${HERO_SMS_SERVICE_QUERY:-}"
SMS_PRICE_RANKING="${HERO_SMS_PRICE_RANKING:-off}"
LIST_SMS_SERVICES=false
PROXY_COUNT=0
declare -a PROXIES=()

if [ "$FORCE_SIGNUP_DEFAULT" = "1" ] || [ "$FORCE_SIGNUP_DEFAULT" = "true" ] || [ "$FORCE_SIGNUP_DEFAULT" = "yes" ]; then
    FORCE_SIGNUP=true
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)
            PROCESS_ALL=true
            shift
            ;;
        --index)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --index requires a value"
                exit 1
            fi
            ACCOUNT_INDEX="$1"
            shift
            ;;
        --accounts-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --accounts-file requires a path"
                exit 1
            fi
            ACCOUNTS_FILE="$1"
            shift
            ;;
        --env-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --env-file requires a path"
                exit 1
            fi
            # Already loaded during bootstrap stage before defaults were expanded.
            shift
            ;;
        --env-file=*)
            if [[ -z "${1#--env-file=}" ]]; then
                echo "Error: --env-file requires a path"
                exit 1
            fi
            # Already loaded during bootstrap stage before defaults were expanded.
            shift
            ;;
        --no-env-file)
            # Already handled during bootstrap stage.
            shift
            ;;
        --signup)
            FORCE_SIGNUP=true
            shift
            ;;
        --proxy-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --proxy-file requires a path"
                exit 1
            fi
            PROXY_FILE="$1"
            shift
            ;;
        --proxy-scheme)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --proxy-scheme requires a value"
                exit 1
            fi
            PROXY_SCHEME="$1"
            shift
            ;;
        --max-proxy-attempts)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --max-proxy-attempts requires a value"
                exit 1
            fi
            MAX_PROXY_ATTEMPTS="$1"
            shift
            ;;
        --proxy-cooldown-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --proxy-cooldown-file requires a path"
                exit 1
            fi
            PROXY_COOLDOWN_FILE="$1"
            shift
            ;;
        --browser-engine)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --browser-engine requires a value (auto|puppeteer|playwright)"
                exit 1
            fi
            BROWSER_ENGINE="$1"
            shift
            ;;
        --state-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --state-file requires a path"
                exit 1
            fi
            STATE_FILE="$1"
            shift
            ;;
        --used-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --used-file requires a path"
                exit 1
            fi
            USED_ACCOUNTS_FILE="$1"
            shift
            ;;
        --no-skip-existing-auth)
            SKIP_EXISTING_AUTH=false
            shift
            ;;
        --resume)
            RESUME_MODE=true
            shift
            ;;
        --reset-state)
            RESET_STATE=true
            shift
            ;;
        --names-file)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --names-file requires a path"
                exit 1
            fi
            NAMES_FILE="$1"
            shift
            ;;
        --sms-services)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --sms-services requires a CSV value"
                exit 1
            fi
            SMS_SERVICES="$1"
            shift
            ;;
        --sms-service-prefix)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --sms-service-prefix requires a value"
                exit 1
            fi
            SMS_SERVICE_PREFIX="$1"
            shift
            ;;
        --sms-service-query)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --sms-service-query requires a value"
                exit 1
            fi
            SMS_SERVICE_QUERY="$1"
            shift
            ;;
        --sms-price-ranking)
            shift
            if [[ -z "${1:-}" ]]; then
                echo "Error: --sms-price-ranking requires a value (price_asc|off)"
                exit 1
            fi
            SMS_PRICE_RANKING="$1"
            shift
            ;;
        --list-sms-services)
            LIST_SMS_SERVICES=true
            shift
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: $0 [--all | --index N] [--accounts-file FILE] [--signup] [--proxy-file FILE] [--proxy-scheme SCHEME] [--max-proxy-attempts N] [--proxy-cooldown-file FILE] [--env-file FILE] [--no-env-file] [--browser-engine auto|puppeteer|playwright] [--state-file FILE] [--used-file FILE] [--no-skip-existing-auth] [--resume] [--reset-state] [--names-file FILE] [--sms-services CSV] [--sms-service-prefix PREFIX] [--sms-service-query TEXT] [--sms-price-ranking MODE] [--list-sms-services]"
            exit 1
            ;;
    esac
done

if [[ "${PROXY_SCHEME,,}" == "socs5" ]]; then
    PROXY_SCHEME="socks5"
fi

if ! [[ "$MAX_PROXY_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$MAX_PROXY_ATTEMPTS" -lt 1 ]; then
    echo "Error: --max-proxy-attempts must be a positive integer"
    exit 1
fi

if ! [[ "$PROXY_PHONE_COOLDOWN_FIRST_SEC" =~ ^[0-9]+$ ]] || [ "$PROXY_PHONE_COOLDOWN_FIRST_SEC" -lt 1 ]; then
    echo "Error: CODEX_PROXY_PHONE_COOLDOWN_FIRST_SEC must be a positive integer"
    exit 1
fi

if ! [[ "$PROXY_PHONE_COOLDOWN_SECOND_SEC" =~ ^[0-9]+$ ]] || [ "$PROXY_PHONE_COOLDOWN_SECOND_SEC" -lt 1 ]; then
    echo "Error: CODEX_PROXY_PHONE_COOLDOWN_SECOND_SEC must be a positive integer"
    exit 1
fi

case "${BROWSER_ENGINE,,}" in
    auto|puppeteer|playwright)
        BROWSER_ENGINE="${BROWSER_ENGINE,,}"
        ;;
    *)
        echo "Error: --browser-engine must be one of: auto, puppeteer, playwright"
        exit 1
        ;;
esac

echo "========================================"
echo "Codex OAuth Auto"
echo "========================================"
echo ""

# Check if cli-proxy-api exists
if [ ! -f "$CLI_BINARY" ]; then
    echo "Error: cli-proxy-api not found at $CLI_BINARY"
    exit 1
fi

# Check accounts file
if [ ! -f "$ACCOUNTS_FILE" ]; then
    echo "Error: accounts file not found at $ACCOUNTS_FILE"
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed"
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "Error: node is required but not installed"
    exit 1
fi

if [ "$LIST_SMS_SERVICES" = true ]; then
    if [ -z "${HERO_SMS_API_KEY:-}" ]; then
        echo "Error: HERO_SMS_API_KEY is required for --list-sms-services"
        exit 1
    fi
    if ! command -v curl >/dev/null 2>&1; then
        echo "Error: curl is required for --list-sms-services"
        exit 1
    fi

    query_lc="$(echo "$SMS_SERVICE_QUERY" | tr '[:upper:]' '[:lower:]')"
    prefix_lc="$(echo "$SMS_SERVICE_PREFIX" | tr '[:upper:]' '[:lower:]')"
    base_url="${HERO_SMS_BASE_URL:-https://hero-sms.com/stubs/handler_api.php}"

    echo "Listing SMS services from: $base_url"
    echo "Filter prefix: ${prefix_lc:-<none>}"
    echo "Filter query : ${query_lc:-<none>}"
    echo ""

    curl -sS "${base_url}?action=getServicesList&api_key=${HERO_SMS_API_KEY}" \
        | jq -r --arg prefix "$prefix_lc" --arg query "$query_lc" '
            (.services // [])
            | map({
                code: ((.code // "") | tostring),
                name: ((.name // "") | tostring)
              })
            | map(select((.code | length) > 0))
            | map(
                . + {
                    code_lc: (.code | ascii_downcase),
                    name_lc: (.name | ascii_downcase)
                }
              )
            | map(select(($prefix == "") or (.code_lc | startswith($prefix)) or (.code_lc | contains($prefix))))
            | map(select(($query == "") or (.code_lc | contains($query)) or (.name_lc | contains($query))))
            | sort_by(.code_lc)
            | .[]
            | "\(.code)\t\(.name)"
        '
    exit 0
fi

acquire_run_lock

if [[ "$STATE_FILE" != /* ]]; then
    STATE_FILE="$PWD/$STATE_FILE"
fi

if [ -n "$NAMES_FILE" ] && [[ "$NAMES_FILE" != /* ]]; then
    NAMES_FILE="$PWD/$NAMES_FILE"
fi

if [[ "$USED_ACCOUNTS_FILE" != /* ]]; then
    USED_ACCOUNTS_FILE="$PWD/$USED_ACCOUNTS_FILE"
fi

if [[ "$PROXY_COOLDOWN_FILE" != /* ]]; then
    PROXY_COOLDOWN_FILE="$PWD/$PROXY_COOLDOWN_FILE"
fi

cleanup_prepared_accounts() {
    ensure_clean_auth_env
    if [ "$TEMP_PREPARED_ACCOUNTS" = true ] && [ -n "$PREPARED_ACCOUNTS_FILE" ]; then
        rm -f "$PREPARED_ACCOUNTS_FILE" 2>/dev/null || true
    fi
}
trap cleanup_prepared_accounts EXIT

compute_prepared_accounts_cache_path() {
    local input_real input_meta names_real names_meta cache_key

    input_real="$(realpath "$ACCOUNTS_FILE" 2>/dev/null || printf '%s' "$ACCOUNTS_FILE")"
    input_meta="$(stat -c '%Y:%s' "$ACCOUNTS_FILE" 2>/dev/null || printf '0:0')"
    names_real=""
    names_meta=""

    if [ -n "$NAMES_FILE" ] && [ -f "$NAMES_FILE" ]; then
        names_real="$(realpath "$NAMES_FILE" 2>/dev/null || printf '%s' "$NAMES_FILE")"
        names_meta="$(stat -c '%Y:%s' "$NAMES_FILE" 2>/dev/null || printf '0:0')"
    fi

    cache_key="$(
        printf '%s\n%s\n%s\n%s\n' "$input_real" "$input_meta" "$names_real" "$names_meta" \
            | sha1sum \
            | awk '{print $1}'
    )"

    mkdir -p "$PREPARED_ACCOUNTS_CACHE_DIR"
    printf '%s/%s.json\n' "$PREPARED_ACCOUNTS_CACHE_DIR" "$cache_key"
}

prepare_accounts_to_cache() {
    local cache_path cache_tmp
    cache_path="$(compute_prepared_accounts_cache_path)"

    if [ -f "$cache_path" ]; then
        PREPARED_ACCOUNTS_FILE="$cache_path"
        echo "Using cached prepared accounts JSON: $PREPARED_ACCOUNTS_FILE"
        return 0
    fi

    cache_tmp="$(mktemp "${cache_path}.tmp.XXXXXX")"
    rm -f "$cache_tmp"

    case "${ACCOUNTS_FILE##*.}" in
        json)
            if [ -n "$NAMES_FILE" ]; then
                echo "Preparing accounts from json format with names file: $ACCOUNTS_FILE"
                node "$SCRIPT_DIR/prepare-accounts.js" \
                    --input "$ACCOUNTS_FILE" \
                    --output "$cache_tmp" \
                    --names-file "$NAMES_FILE"
            else
                cp "$ACCOUNTS_FILE" "$cache_tmp"
            fi
            ;;
        *)
            echo "Preparing accounts from text format: $ACCOUNTS_FILE"
            PREPARE_ARGS=(--input "$ACCOUNTS_FILE" --output "$cache_tmp")
            if [ -n "$NAMES_FILE" ]; then
                PREPARE_ARGS+=(--names-file "$NAMES_FILE")
            fi
            node "$SCRIPT_DIR/prepare-accounts.js" "${PREPARE_ARGS[@]}"
            ;;
    esac

    mv "$cache_tmp" "$cache_path"
    PREPARED_ACCOUNTS_FILE="$cache_path"
    echo "Prepared accounts JSON cached at: $PREPARED_ACCOUNTS_FILE"
}

init_proxy_cooldown_file() {
    mkdir -p "$(dirname "$PROXY_COOLDOWN_FILE")"
    if [ ! -f "$PROXY_COOLDOWN_FILE" ]; then
        printf '{}\n' > "$PROXY_COOLDOWN_FILE"
        return
    fi
    if ! jq -e . "$PROXY_COOLDOWN_FILE" >/dev/null 2>&1; then
        local broken_backup="${PROXY_COOLDOWN_FILE}.broken.$(date +%s)"
        mv "$PROXY_COOLDOWN_FILE" "$broken_backup"
        echo "Warning: proxy cooldown file was invalid JSON and moved to: $broken_backup"
        printf '{}\n' > "$PROXY_COOLDOWN_FILE"
    fi
}

proxy_cooldown_key() {
    local proxy="$1"
    printf '%s|%s\n' "$PROXY_SCHEME" "$proxy"
}

proxy_cooldown_until() {
    local key="$1"
    local value
    value="$(jq -r --arg key "$key" '.[$key].cooldown_until // 0' "$PROXY_COOLDOWN_FILE" 2>/dev/null || echo 0)"
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then
        value=0
    fi
    printf '%s\n' "$value"
}

proxy_cooldown_level() {
    local key="$1"
    local value
    value="$(jq -r --arg key "$key" '.[$key].cooldown_level // 0' "$PROXY_COOLDOWN_FILE" 2>/dev/null || echo 0)"
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then
        value=0
    fi
    printf '%s\n' "$value"
}

select_proxy_for_attempt() {
    local account_idx="$1"
    local attempt_idx="$2"
    local base_idx now offset candidate_idx candidate key cooldown_until remaining
    local best_remaining=-1

    now="$(date +%s)"
    base_idx=$(( (account_idx + attempt_idx) % PROXY_COUNT ))

    for ((offset=0; offset<PROXY_COUNT; offset++)); do
        candidate_idx=$(( (base_idx + offset) % PROXY_COUNT ))
        candidate="${PROXIES[$candidate_idx]}"
        key="$(proxy_cooldown_key "$candidate")"
        cooldown_until="$(proxy_cooldown_until "$key")"
        if [ "$cooldown_until" -le "$now" ]; then
            printf '%s|%s|0\n' "$candidate_idx" "$candidate"
            return 0
        fi
        remaining=$((cooldown_until - now))
        if [ "$best_remaining" -lt 0 ] || [ "$remaining" -lt "$best_remaining" ]; then
            best_remaining="$remaining"
        fi
    done

    printf '%s||%s\n' "-1" "$best_remaining"
    return 1
}

login_log_has_phone_signal() {
    local login_log="$1"
    local result_reason="$2"

    if printf '%s\n' "$result_reason" | grep -Eqi 'phone_required|add-phone'; then
        return 0
    fi

    [ -n "$login_log" ] && [ -f "$login_log" ] && grep -Eqi 'Phone number required by OpenAI|/add-phone|phone_required:' "$login_log" 2>/dev/null
}

proxy_mark_phone_cooldown() {
    local proxy="$1"
    local key level duration now until until_iso tmp

    if [ -z "$proxy" ] || [ "$proxy" = "null" ]; then
        return 0
    fi

    key="$(proxy_cooldown_key "$proxy")"
    level="$(proxy_cooldown_level "$key")"
    if [ "$level" -ge 1 ]; then
        level=2
        duration="$PROXY_PHONE_COOLDOWN_SECOND_SEC"
    else
        level=1
        duration="$PROXY_PHONE_COOLDOWN_FIRST_SEC"
    fi

    now="$(date +%s)"
    until=$((now + duration))
    until_iso="$(date -u -d "@$until" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "$until")"
    tmp="$(mktemp)"
    jq \
        --arg key "$key" \
        --arg proxy "$proxy" \
        --arg scheme "$PROXY_SCHEME" \
        --argjson now "$now" \
        --argjson until "$until" \
        --argjson level "$level" \
        '
        .[$key] = ((.[$key] // {}) + {
            proxy:$proxy,
            scheme:$scheme,
            cooldown_level:$level,
            last_phone_at:$now,
            cooldown_until:$until
        })
        ' "$PROXY_COOLDOWN_FILE" > "$tmp" && mv "$tmp" "$PROXY_COOLDOWN_FILE"

    echo "[proxy-cooldown] phone step detected: proxy=$proxy level=$level cooldown=${duration}s until=$until_iso"
}

init_state_file() {
    local now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    mkdir -p "$(dirname "$STATE_FILE")"
    if [ "$RESET_STATE" = true ] && [ -f "$STATE_FILE" ]; then
        rm -f "$STATE_FILE"
    fi

    if [ ! -f "$STATE_FILE" ]; then
        jq -n \
            --arg now "$now" \
            --arg script "codex-auto.sh" \
            '{version:1, script:$script, created_at:$now, updated_at:$now, run_count:0, runs:[], accounts:{}}' > "$STATE_FILE"
        return
    fi

    if ! jq -e . "$STATE_FILE" >/dev/null 2>&1; then
        local broken_backup="${STATE_FILE}.broken.$(date +%s)"
        mv "$STATE_FILE" "$broken_backup"
        echo "Warning: state file was invalid JSON and moved to: $broken_backup"
        jq -n \
            --arg now "$now" \
            --arg script "codex-auto.sh" \
            '{version:1, script:$script, created_at:$now, updated_at:$now, run_count:0, runs:[], accounts:{}}' > "$STATE_FILE"
    fi
}

state_write_meta() {
    local tmp now mode
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    mode="single"
    if [ "$PROCESS_ALL" = true ]; then
        mode="all"
    fi
    tmp="$(mktemp)"
    jq \
        --arg now "$now" \
        --arg accounts_file "$ACCOUNTS_FILE" \
        --arg prepared_file "$PREPARED_ACCOUNTS_FILE" \
        --arg proxy_file "$PROXY_FILE" \
        --arg proxy_scheme "$PROXY_SCHEME" \
        --arg browser_engine "$BROWSER_ENGINE" \
        --arg names_file "$NAMES_FILE" \
        --arg sms_services "$SMS_SERVICES" \
        --arg sms_service_prefix "$SMS_SERVICE_PREFIX" \
        --arg sms_service_query "$SMS_SERVICE_QUERY" \
        --arg sms_price_ranking "$SMS_PRICE_RANKING" \
        --arg mode "$mode" \
        --argjson signup "$([ "$FORCE_SIGNUP" = true ] && echo true || echo false)" \
        --argjson resume "$([ "$RESUME_MODE" = true ] && echo true || echo false)" \
        --argjson reset "$([ "$RESET_STATE" = true ] && echo true || echo false)" \
        --argjson count "$ACCOUNT_COUNT" \
        '
        .updated_at=$now
        | .run_count=((.run_count // 0)+1)
        | .runs=((.runs // []) + [{
            started_at:$now,
            mode:$mode,
            signup:$signup,
            resume:$resume,
            reset:$reset,
            browser_engine:$browser_engine,
            names_file:$names_file,
            sms_services:$sms_services,
            sms_service_prefix:$sms_service_prefix,
            sms_service_query:$sms_service_query,
            sms_price_ranking:$sms_price_ranking,
            proxy_file:$proxy_file,
            proxy_scheme:$proxy_scheme,
            accounts_file:$accounts_file,
            prepared_accounts_file:$prepared_file,
            account_count:$count
        }])
        ' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

state_get_status() {
    local email="$1"
    jq -r --arg email "$email" '.accounts[$email].status // ""' "$STATE_FILE" 2>/dev/null
}

state_update_account() {
    local email="$1"
    local status="$2"
    local reason="$3"
    local index="$4"
    local attempt="$5"
    local proxy="$6"
    local callback="$7"
    local tmp now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    tmp="$(mktemp)"
    jq \
        --arg email "$email" \
        --arg status "$status" \
        --arg reason "$reason" \
        --arg proxy "$proxy" \
        --arg callback "$callback" \
        --arg now "$now" \
        --argjson index "$index" \
        --argjson attempt "$attempt" \
        '
        .updated_at=$now
        | .accounts[$email] = ((.accounts[$email] // {email:$email, tries:0}) + {
            email:$email,
            status:$status,
            last_reason:$reason,
            last_index:$index,
            last_attempt:$attempt,
            proxy:$proxy,
            callback_url:$callback,
            updated_at:$now
        })
        | if $status == "running"
            then .accounts[$email].tries = ((.accounts[$email].tries // 0) + 1)
            else .
          end
        | if $status == "success"
            then .accounts[$email].success_at=$now
            else .
          end
        ' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

state_mark_skipped() {
    local email="$1"
    local index="$2"
    local tmp now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    tmp="$(mktemp)"
    jq \
        --arg email "$email" \
        --arg now "$now" \
        --argjson index "$index" \
        '
        .updated_at=$now
        | .accounts[$email] = ((.accounts[$email] // {email:$email, tries:0}) + {
            email:$email,
            status:"success",
            last_reason:"skipped_resume_success",
            last_index:$index,
            updated_at:$now
        })
        ' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

state_finalize_run() {
    local success="$1"
    local failed="$2"
    local skipped="$3"
    local tmp now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    tmp="$(mktemp)"
    jq \
        --arg now "$now" \
        --argjson success "$success" \
        --argjson failed "$failed" \
        --argjson skipped "$skipped" \
        '
        .updated_at=$now
        | .last_run_summary = {
            finished_at:$now,
            success:$success,
            failed:$failed,
            skipped:$skipped
          }
        | if (.runs | length) > 0
            then .runs[-1].finished_at = $now
            | .runs[-1].summary = {
                success:$success,
                failed:$failed,
                skipped:$skipped
              }
            else .
          end
        ' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
}

init_used_accounts_file() {
    mkdir -p "$(dirname "$USED_ACCOUNTS_FILE")"
    touch "$USED_ACCOUNTS_FILE"
}

used_accounts_has_email() {
    local email="$1"
    local codex_auth_file=""
    codex_auth_file="$(find_codex_auth_file_for_email "$email")"
    [ -n "$codex_auth_file" ] || return 1
    [ -f "$USED_ACCOUNTS_FILE" ] || return 1
    grep -Fq "|$email|" "$USED_ACCOUNTS_FILE"
}

mark_used_account_success() {
    local email="$1"
    local index="$2"
    local auth_file="$3"
    local now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    if used_accounts_has_email "$email"; then
        return 0
    fi
    printf '%s|%s|%s|%s\n' "$now" "$index" "$email" "$auth_file" >> "$USED_ACCOUNTS_FILE"
}

if [ -n "$NAMES_FILE" ] && [ ! -f "$NAMES_FILE" ]; then
    echo "Error: names file not found at $NAMES_FILE"
    exit 1
fi

prepare_accounts_to_cache

# Get account count
ACCOUNT_COUNT=$(jq length "$PREPARED_ACCOUNTS_FILE")
init_state_file
init_used_accounts_file
init_proxy_cooldown_file
state_write_meta

echo "Using accounts file: $ACCOUNTS_FILE"
if [ -n "$LOADED_ENV_FILE" ]; then
    echo "Loaded env profile: $LOADED_ENV_FILE"
fi
if [ "$PREPARED_ACCOUNTS_FILE" != "$ACCOUNTS_FILE" ]; then
    echo "Prepared accounts JSON: $PREPARED_ACCOUNTS_FILE"
fi
if [ -n "$NAMES_FILE" ]; then
    echo "Names file: $NAMES_FILE"
fi
if [ -n "$SMS_SERVICES" ]; then
    echo "SMS services: $SMS_SERVICES"
fi
if [ -n "$SMS_SERVICE_PREFIX" ]; then
    echo "SMS service prefix: $SMS_SERVICE_PREFIX"
fi
if [ -n "$SMS_SERVICE_QUERY" ]; then
    echo "SMS service query: $SMS_SERVICE_QUERY"
fi
if [ -n "$SMS_PRICE_RANKING" ]; then
    echo "SMS price ranking: $SMS_PRICE_RANKING"
fi
echo "Found $ACCOUNT_COUNT account(s)"
echo "CLI binary: $CLI_BINARY"
echo "CLI workdir: $CLI_WORKDIR"
echo "Run lock file: $RUN_LOCK_FILE"
echo "State file: $STATE_FILE"
echo "Used accounts file: $USED_ACCOUNTS_FILE"
echo "Proxy cooldown file: $PROXY_COOLDOWN_FILE"
echo "Proxy phone cooldowns: first=${PROXY_PHONE_COOLDOWN_FIRST_SEC}s second=${PROXY_PHONE_COOLDOWN_SECOND_SEC}s"
if [ "$SKIP_EXISTING_AUTH" = true ]; then
    echo "Skip existing auth files: enabled"
else
    echo "Skip existing auth files: disabled"
fi
if [ "$RESUME_MODE" = true ]; then
    echo "Resume mode: enabled"
fi
echo ""

if [ -n "$PROXY_FILE" ]; then
    if [ ! -f "$PROXY_FILE" ]; then
        echo "Error: proxy file not found at $PROXY_FILE"
        exit 1
    fi

    mapfile -t PROXIES < <(grep -vE '^\s*($|#)' "$PROXY_FILE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    PROXY_COUNT=${#PROXIES[@]}
    if [ "$PROXY_COUNT" -eq 0 ]; then
        echo "Warning: proxy file is empty after filtering comments/blank lines. Running without proxy."
    else
        echo "Using proxy file: $PROXY_FILE"
        echo "Proxy scheme: $PROXY_SCHEME"
        echo "Loaded proxy entries: $PROXY_COUNT"
        echo "Max proxy attempts/account: $MAX_PROXY_ATTEMPTS"
    fi
    echo ""
fi

echo "Browser engine: $BROWSER_ENGINE"
echo ""

# Determine which accounts to process
if [ "$PROCESS_ALL" = true ]; then
    START_INDEX=0
    END_INDEX=$ACCOUNT_COUNT
    echo "Mode: Process ALL accounts"
else
    START_INDEX=$ACCOUNT_INDEX
    END_INDEX=$((ACCOUNT_INDEX + 1))
    echo "Mode: Process account #$ACCOUNT_INDEX"
fi
echo ""
if [ "$FORCE_SIGNUP" = true ]; then
    echo "Sign Up mode: ENABLED"
else
    echo "Sign Up mode: AUTO (sign-in first)"
fi
echo ""

wait_for_auth_url() {
    local output="" login_url=""
    for i in {1..30}; do
        if [ -n "${CURRENT_AUTH_LOG:-}" ] && [ -f "$CURRENT_AUTH_LOG" ]; then
            output="$(tail -80 "$CURRENT_AUTH_LOG" 2>/dev/null || true)"
            if echo "$output" | grep -q "auth.openai.com"; then
                login_url=$(extract_auth_url "$output")
                if [ -n "$login_url" ]; then
                    echo "$login_url"
                    return 0
                fi
            fi
        fi
        if [ -n "${CLI_AUTH_PID:-}" ] && ! kill -0 "$CLI_AUTH_PID" 2>/dev/null; then
            break
        fi
        sleep 1
    done
    return 1
}

wait_for_port_1455() {
    for i in {1..15}; do
        if netstat -tuln 2>/dev/null | grep -q ':1455 ' || ss -tuln 2>/dev/null | grep -q ':1455 '; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# Process each account
TOTAL_SUCCESS=0
TOTAL_FAILED=0
TOTAL_SKIPPED=0

for ((idx=START_INDEX; idx<END_INDEX; idx++)); do
    echo "========================================"
    echo "Processing account #$idx"
    echo "========================================"
    
    # Get account info
    ACCOUNT_EMAIL=$(jq -r ".[$idx].email" "$PREPARED_ACCOUNTS_FILE")
    if [ -z "$ACCOUNT_EMAIL" ] || [ "$ACCOUNT_EMAIL" = "null" ]; then
        echo "✗ Invalid account entry at index $idx (missing email)"
        state_update_account "index-$idx" "failed" "invalid_account_entry" "$idx" 0 "" ""
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        echo ""
        continue
    fi
    echo "Email: $ACCOUNT_EMAIL"
    echo ""

    EXISTING_AUTH_FILE="$(find_codex_auth_file_for_email "$ACCOUNT_EMAIL")"
    if used_accounts_has_email "$ACCOUNT_EMAIL"; then
        echo "↷ Skipping account #$idx (already marked used in registry)"
        state_update_account "$ACCOUNT_EMAIL" "success" "skipped_used_registry" "$idx" 0 "" "$EXISTING_AUTH_FILE"
        TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
        echo ""
        continue
    fi

    if [ "$SKIP_EXISTING_AUTH" = true ] && [ -n "$EXISTING_AUTH_FILE" ]; then
        echo "↷ Skipping account #$idx (auth file already exists: $EXISTING_AUTH_FILE)"
        mark_used_account_success "$ACCOUNT_EMAIL" "$idx" "$EXISTING_AUTH_FILE"
        state_update_account "$ACCOUNT_EMAIL" "success" "skipped_existing_auth_file" "$idx" 0 "" "$EXISTING_AUTH_FILE"
        TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
        echo ""
        continue
    fi

    if [ "$RESUME_MODE" = true ]; then
        LAST_STATE_STATUS="$(state_get_status "$ACCOUNT_EMAIL")"
        if [ "$LAST_STATE_STATUS" = "success" ]; then
            echo "↷ Skipping account #$idx (already successful in state file)"
            mark_used_account_success "$ACCOUNT_EMAIL" "$idx" "$EXISTING_AUTH_FILE"
            state_mark_skipped "$ACCOUNT_EMAIL" "$idx"
            TOTAL_SKIPPED=$((TOTAL_SKIPPED + 1))
            echo ""
            continue
        fi
    fi

    ATTEMPT_LIMIT=1
    if [ "$PROXY_COUNT" -gt 0 ]; then
        ATTEMPT_LIMIT="$MAX_PROXY_ATTEMPTS"
        if [ "$ATTEMPT_LIMIT" -gt "$PROXY_COUNT" ]; then
            ATTEMPT_LIMIT="$PROXY_COUNT"
        fi
    fi

    ACCOUNT_DONE=false
    ACCOUNT_REASON="unknown"

    for ((attempt=0; attempt<ATTEMPT_LIMIT; attempt++)); do
        echo "----- Attempt $((attempt + 1))/$ATTEMPT_LIMIT for account #$idx -----"

        SELECTED_PROXY=""
        SELECTED_PROXY_IDX=-1
        if [ "$PROXY_COUNT" -gt 0 ]; then
            selected_proxy_line="$(select_proxy_for_attempt "$idx" "$attempt")"
            IFS='|' read -r SELECTED_PROXY_IDX SELECTED_PROXY PROXY_COOLDOWN_REMAINING <<< "$selected_proxy_line"
            if [ "${SELECTED_PROXY_IDX:--1}" -lt 0 ] || [ -z "$SELECTED_PROXY" ]; then
                echo "✗ No available proxy (all proxies in cooldown, nearest unlock in ${PROXY_COOLDOWN_REMAINING:-0}s)"
                ACCOUNT_REASON="proxy_all_in_cooldown"
                state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "" ""
                sleep 2
                continue
            fi
            echo "Proxy #$SELECTED_PROXY_IDX: $SELECTED_PROXY (scheme: $PROXY_SCHEME)"
        else
            echo "Proxy: disabled"
        fi

        state_update_account "$ACCOUNT_EMAIL" "running" "attempt_started" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""

        ensure_clean_auth_env
        sleep 1

        CURRENT_AUTH_LOG="/tmp/codex-cli-auth-${idx}-${attempt}-${RUN_TAG}.log"
        rm -f "$CURRENT_AUTH_LOG" 2>/dev/null || true

        echo "Starting cli-proxy-api for account #$idx..."
        if ! start_cli_auth_with_recover "$CURRENT_AUTH_LOG"; then
            echo "✗ Failed to start cli-proxy-api auth listener on port 1455 after retries"
            ACCOUNT_REASON="local_callback_port_in_use"
            state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""
            ensure_clean_auth_env
            continue
        fi

        # Wait until port 1455 is actually listening
        echo "Waiting for port 1455 to be ready..."
        PORT_READY=false
        for port_wait in $(seq 1 15); do
            if ss -tuln 2>/dev/null | grep -q ':1455 ' || netstat -tuln 2>/dev/null | grep -q ':1455 '; then
                PORT_READY=true
                break
            fi
            sleep 1
        done
        if [ "$PORT_READY" != true ]; then
            echo "Warning: port 1455 not ready after 15s"
        fi

        echo "Waiting for auth URL..."
        LOGIN_URL="$(wait_for_auth_url || true)"
        if [ -z "$LOGIN_URL" ]; then
            echo "✗ Failed to extract auth URL for account #$idx on attempt $((attempt + 1))"
            if [ -f "$CURRENT_AUTH_LOG" ]; then
                echo "Recent cli-proxy-api output:"
                tail -20 "$CURRENT_AUTH_LOG"
                if grep -qi "failed to load config" "$CURRENT_AUTH_LOG"; then
                    ACCOUNT_REASON="cli_start_failed_config"
                fi
            fi
            if [ "$ACCOUNT_REASON" = "unknown" ] || [ -z "$ACCOUNT_REASON" ]; then
                ACCOUNT_REASON="auth_url_missing"
            fi
            state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""
            ensure_clean_auth_env
            continue
        fi
        echo "Auth URL: ${LOGIN_URL:0:80}..."

        echo "Waiting for port 1455..."
        if ! wait_for_port_1455; then
            echo "✗ Port 1455 is not ready"
            ACCOUNT_REASON="local_callback_port_unavailable"
            state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""
            ensure_clean_auth_env
            continue
        fi

        LOGIN_LOG="/tmp/login-detail-${idx}-${attempt}.txt"
        NODE_ENV_ARGS=("CODEX_ACCOUNTS_FILE=$PREPARED_ACCOUNTS_FILE")
        NODE_ENV_ARGS+=("CODEX_BROWSER_ENGINE=$BROWSER_ENGINE")
        if [ -n "$SMS_SERVICES" ]; then
            NODE_ENV_ARGS+=("HERO_SMS_SERVICES=$SMS_SERVICES")
        fi
        if [ -n "$SMS_SERVICE_PREFIX" ]; then
            NODE_ENV_ARGS+=("HERO_SMS_SERVICE_PREFIX=$SMS_SERVICE_PREFIX")
        fi
        if [ -n "$SMS_SERVICE_QUERY" ]; then
            NODE_ENV_ARGS+=("HERO_SMS_SERVICE_QUERY=$SMS_SERVICE_QUERY")
        fi
        if [ -n "$SMS_PRICE_RANKING" ]; then
            NODE_ENV_ARGS+=("HERO_SMS_PRICE_RANKING=$SMS_PRICE_RANKING")
        fi
        if [ "$FORCE_SIGNUP" = true ]; then
            NODE_ENV_ARGS+=("CODEX_ENABLE_SIGNUP_FLOW=1")
        fi
        if [ -n "$SELECTED_PROXY" ]; then
            NODE_ENV_ARGS+=("CODEX_PROXY_ENTRY=$SELECTED_PROXY")
            NODE_ENV_ARGS+=("CODEX_PROXY_SCHEME=$PROXY_SCHEME")
        fi

        env "${NODE_ENV_ARGS[@]}" node "$SCRIPT_DIR/codex-login.js" "$LOGIN_URL" "$idx" 2>&1 | tee "$LOGIN_LOG"
        LOGIN_EXIT=${PIPESTATUS[0]}

        CALLBACK_URL=$(extract_callback_url "$(cat "$LOGIN_LOG" 2>/dev/null)")
        RESULT_REASON=$(grep -oP 'RESULT_REASON:\K.*' "$LOGIN_LOG" | tail -n 1)
        [ -n "$RESULT_REASON" ] && ACCOUNT_REASON="$RESULT_REASON"

        # New accounts commonly fail Sign In first; automatically retry once with Sign Up flow.
        if [ -z "$CALLBACK_URL" ] \
            && [ "$FORCE_SIGNUP" != true ] \
            && [ "$AUTO_SIGNUP_ON_LOGIN_FAIL" = "1" ]; then
            if [ "$RESULT_REASON" = "password_verify_401" ] \
                || [ "$RESULT_REASON" = "No callback URL with auth code captured" ] \
                || grep -q '\[HTTP 401\].*/api/accounts/password/verify' "$LOGIN_LOG" 2>/dev/null; then
                echo "↻ Sign In failed for account #$idx; retrying once in Sign Up mode..."
                NODE_ENV_ARGS_SIGNUP=("${NODE_ENV_ARGS[@]}")
                NODE_ENV_ARGS_SIGNUP+=("CODEX_ENABLE_SIGNUP_FLOW=1")
                env "${NODE_ENV_ARGS_SIGNUP[@]}" node "$SCRIPT_DIR/codex-login.js" "$LOGIN_URL" "$idx" 2>&1 | tee -a "$LOGIN_LOG"
                LOGIN_EXIT=${PIPESTATUS[0]}

                CALLBACK_URL=$(extract_callback_url "$(cat "$LOGIN_LOG" 2>/dev/null)")
                RESULT_REASON=$(grep -oP 'RESULT_REASON:\K.*' "$LOGIN_LOG" | tail -n 1)
                [ -n "$RESULT_REASON" ] && ACCOUNT_REASON="$RESULT_REASON"
            fi
        fi

        PHONE_STEP_DETECTED=false
        if login_log_has_phone_signal "$LOGIN_LOG" "$RESULT_REASON"; then
            PHONE_STEP_DETECTED=true
            if [ -n "$SELECTED_PROXY" ]; then
                proxy_mark_phone_cooldown "$SELECTED_PROXY"
            fi
        fi

        echo ""

        if [ -n "$CALLBACK_URL" ]; then
            echo "✓ Got callback URL for account #$idx"
            echo "[callback-debug] selected callback URL: $CALLBACK_URL"
            sleep 3
            CALLBACK_SUBMIT_METHOD="listener"
            CURL_HTTP_CODE=""
            CURL_BODY=""
            SAVED_AUTH_FILE=""

            if callback_was_delivered_locally "$LOGIN_LOG"; then
                echo "[callback-debug] local callback listener already received the redirect"
            elif auth_log_has_success; then
                echo "[callback-debug] cliproxyapi already completed auth after local callback"
            elif submit_callback_via_prompt "$CALLBACK_URL"; then
                echo "Submitting callback URL via cliproxyapi stdin..."
                CALLBACK_SUBMIT_METHOD="stdin"
            else
                CALLBACK_SUBMIT_METHOD="http"
                echo "Prompt handoff not available, sending callback via HTTP to cliproxyapi on port 1455..."
                echo "[callback-debug] port 1455 snapshot before HTTP submit:"
                ss -tuln 2>/dev/null | grep ':1455 ' || netstat -tuln 2>/dev/null | grep ':1455 ' || echo "[callback-debug] no listener reported by ss/netstat"

                # Send callback via HTTP directly to cliproxyapi's OAuth server
                CURL_OUTPUT=$(curl -sS -w "\n%{http_code}" --max-time 15 "$CALLBACK_URL" 2>&1) || true
                CURL_HTTP_CODE=$(echo "$CURL_OUTPUT" | tail -1)
                CURL_BODY=$(echo "$CURL_OUTPUT" | head -n -1)
                echo "Callback HTTP response: $CURL_HTTP_CODE"
                if [ -n "$CURL_BODY" ]; then
                    echo "[callback-debug] callback HTTP body:"
                    printf '%s\n' "$CURL_BODY"
                fi
            fi
            
            # Give cli-proxy-api time to write success message to log
            sleep 2
            
            # Wait for cli-proxy-api to process the callback, exchange tokens, and save auth.
            AUTH_SUCCESS=false
            echo "[callback-debug] waiting up to ${POST_CALLBACK_WAIT_SECONDS}s for post-callback completion"
            for wait_iter in $(seq 1 "$POST_CALLBACK_WAIT_SECONDS"); do
                sleep 1
                if auth_log_has_success; then
                    AUTH_SUCCESS=true
                    break
                fi
                SAVED_AUTH_FILE="$(find_codex_auth_file_for_email "$ACCOUNT_EMAIL")"
                if [ -n "$SAVED_AUTH_FILE" ]; then
                    AUTH_SUCCESS=true
                    break
                fi
                if [ -n "${CLI_AUTH_PID:-}" ] && ! kill -0 "$CLI_AUTH_PID" 2>/dev/null; then
                    echo "[callback-debug] cli auth process exited while waiting on post-callback completion"
                    break
                fi
            done

            # Read final output from auth log
            if [ -f "$CURRENT_AUTH_LOG" ]; then
                CLI_AUTH_OUTPUT=$(tail -35 "$CURRENT_AUTH_LOG")
            else
                CLI_AUTH_OUTPUT=""
            fi

            if [ "$AUTH_SUCCESS" = true ]; then
                echo "✓ Account #$idx authorized successfully!"
                if [ -z "$SAVED_AUTH_FILE" ]; then
                    SAVED_AUTH_FILE="$(find_codex_auth_file_for_email "$ACCOUNT_EMAIL")"
                fi
                if [ -n "$SAVED_AUTH_FILE" ]; then
                    echo "Auth file: $SAVED_AUTH_FILE"
                fi
                mark_used_account_success "$ACCOUNT_EMAIL" "$idx" "$SAVED_AUTH_FILE"
                ACCOUNT_DONE=true
                ACCOUNT_REASON="success"
                state_update_account "$ACCOUNT_EMAIL" "success" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" "$CALLBACK_URL"
            elif echo "$CLI_AUTH_OUTPUT" | grep -qi "failed\|error\|invalid\|timeout"; then
                echo "✗ Account #$idx authorization failed after callback submit"
                ACCOUNT_REASON="callback_rejected"
                state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" "$CALLBACK_URL"
            else
                if [ "$CALLBACK_SUBMIT_METHOD" = "http" ]; then
                    echo "? Account #$idx - unclear auth status (submit=http, HTTP=$CURL_HTTP_CODE)"
                elif [ "$CALLBACK_SUBMIT_METHOD" = "stdin" ]; then
                    echo "? Account #$idx - unclear auth status (submit=stdin)"
                elif [ "$CALLBACK_SUBMIT_METHOD" = "listener" ]; then
                    echo "? Account #$idx - unclear auth status (submit=listener)"
                else
                    echo "? Account #$idx - unclear auth status (submit=$CALLBACK_SUBMIT_METHOD)"
                fi
                ACCOUNT_REASON="callback_submitted_unknown_result"
                state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" "$CALLBACK_URL"
            fi

            echo ""
            echo "cli-proxy-api output:"
            echo "$CLI_AUTH_OUTPUT"

            if [ "$ACCOUNT_DONE" = true ]; then
                rm -f "$LOGIN_LOG" 2>/dev/null
                ensure_clean_auth_env
                break
            fi
        else
            echo "✗ Failed to get callback URL for account #$idx (attempt $((attempt + 1)), exit=$LOGIN_EXIT, reason=${RESULT_REASON:-unknown})"
            state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""
        fi

        ensure_clean_auth_env
        rm -f "$LOGIN_LOG" 2>/dev/null
        if [ $((attempt + 1)) -lt "$ATTEMPT_LIMIT" ]; then
            echo "Retrying with next proxy..."
            echo ""
            sleep 2
        fi
    done

    if [ "$ACCOUNT_DONE" != true ]; then
        echo "Final status for account #$idx: FAILED ($ACCOUNT_REASON)"
        state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$ATTEMPT_LIMIT" "" ""
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    else
        TOTAL_SUCCESS=$((TOTAL_SUCCESS + 1))
    fi

    echo ""
    echo "Waiting before next account..."
    sleep 3
done

echo ""
echo "========================================"
echo "Batch processing completed"
echo "========================================"
echo "Success: $TOTAL_SUCCESS"
echo "Failed: $TOTAL_FAILED"
echo "Skipped (resume): $TOTAL_SKIPPED"
state_finalize_run "$TOTAL_SUCCESS" "$TOTAL_FAILED" "$TOTAL_SKIPPED"
echo ""
echo "Authentication subprocesses were managed inline in this shell run."

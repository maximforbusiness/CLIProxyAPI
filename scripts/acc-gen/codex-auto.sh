#!/bin/bash

# Codex OAuth Auto - Batch account authorization
# Usage:
#   codex-auto.sh [--all | --index N] [--accounts-file FILE] [--signup] \
#                 [--proxy-file FILE] [--proxy-scheme SCHEME] [--max-proxy-attempts N] \
#                 [--browser-engine auto|puppeteer|playwright] \
#                 [--state-file FILE] [--resume] [--reset-state] [--names-file FILE] \
#                 [--sms-services CSV] [--sms-service-prefix PREFIX] [--sms-service-query TEXT] \
#                 [--sms-price-ranking MODE] [--list-sms-services]
#   --all                  : Process all accounts in accounts file (.json or text)
#   --index N              : Process only account at index N (0-based)
#   --proxy-file FILE      : One proxy per line (supports host:port@user:pass and user:pass@host:port)
#   --proxy-scheme SCHEME  : http|https|socks5|socks4 (default: socks5)
#   --max-proxy-attempts N : Max proxy attempts per account when proxy file is set (default: 3)
#   --browser-engine       : Browser launcher preference (default: auto)
#   --state-file FILE      : JSON state file for progress tracking/resume
#   --resume               : Skip accounts already marked success in state file
#   --reset-state          : Reset state file before run
#   --names-file FILE      : Full-name list for about-you step (First Last per line)
#   --sms-services CSV     : SMS service codes (comma-separated), supports wildcard entries like op*
#   --sms-service-prefix X : Prefix filter for SMS service codes
#   --sms-service-query X  : Search in SMS service code/name (if omitted, codex-login default applies)
#   --sms-price-ranking X  : price_asc (default) | off
#   --list-sms-services    : Print available services (respects prefix/query) and exit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
CLI_BINARY="$PROJECT_DIR/cli-proxy-api"
CLI_WORKDIR="$PROJECT_DIR"
RUN_TAG="${CODEX_RUN_TAG:-$$}"
ACCOUNTS_FILE="$SCRIPT_DIR/accounts.json"
PREPARED_ACCOUNTS_FILE=""
TEMP_PREPARED_ACCOUNTS=false
NAMES_FILE="${CODEX_NAMES_FILE:-}"
CURRENT_AUTH_LOG=""
CLI_AUTH_PID=""
CLI_AUTH_OUT_FD=""
CLI_AUTH_IN_FD=""
CLI_AUTH_READER_PID=""

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
    find "$CLI_WORKDIR/auth" -maxdepth 1 -type f 2>/dev/null | rg -F "/codex-${email}" | head -n 1
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
    local coproc_out=""
    local coproc_in=""
    : > "$log_path"

    coproc CLI_AUTH_PROC {
        script -qefc "cd \"$CLI_WORKDIR\" && exec \"$CLI_BINARY\" --codex-login --no-browser" /dev/null
    }
    CLI_AUTH_PID="$CLI_AUTH_PROC_PID"
    coproc_out="${CLI_AUTH_PROC[0]}"
    coproc_in="${CLI_AUTH_PROC[1]}"

    exec {CLI_AUTH_OUT_FD}<&"$coproc_out"
    exec {CLI_AUTH_IN_FD}>&"$coproc_in"
    eval "exec ${coproc_out}<&-"
    eval "exec ${coproc_in}>&-"

    stream_cli_auth_output "$CLI_AUTH_OUT_FD" "$log_path" &
    CLI_AUTH_READER_PID=$!
}

stop_cli_auth() {
    local reader_pid="${CLI_AUTH_READER_PID:-}"
    local cli_pid="${CLI_AUTH_PID:-}"
    local out_fd="${CLI_AUTH_OUT_FD:-}"
    local in_fd="${CLI_AUTH_IN_FD:-}"

    if [ -n "$reader_pid" ]; then
        kill "$reader_pid" 2>/dev/null || true
        wait "$reader_pid" 2>/dev/null || true
    fi

    if [ -n "$in_fd" ]; then
        eval "exec ${in_fd}>&-"
    fi
    if [ -n "$out_fd" ]; then
        eval "exec ${out_fd}<&-"
    fi

    if [ -n "$cli_pid" ]; then
        kill "$cli_pid" 2>/dev/null || true
        wait "$cli_pid" 2>/dev/null || true
    fi

    CLI_AUTH_PID=""
    CLI_AUTH_OUT_FD=""
    CLI_AUTH_IN_FD=""
    CLI_AUTH_READER_PID=""
}

# Parse arguments
PROCESS_ALL=false
ACCOUNT_INDEX=0
FORCE_SIGNUP=false
PROXY_FILE=""
PROXY_SCHEME="${CODEX_PROXY_SCHEME:-socks5}"
MAX_PROXY_ATTEMPTS="${CODEX_MAX_PROXY_ATTEMPTS:-3}"
POST_CALLBACK_WAIT_SECONDS="${CODEX_POST_CALLBACK_WAIT_SECONDS:-125}"
BROWSER_ENGINE="${CODEX_BROWSER_ENGINE:-auto}"
STATE_FILE="${CODEX_STATE_FILE:-$SCRIPT_DIR/codex-auto-state.json}"
RESUME_MODE=false
RESET_STATE=false
SMS_SERVICES="${HERO_SMS_SERVICES:-}"
SMS_SERVICE_PREFIX="${HERO_SMS_SERVICE_PREFIX:-}"
SMS_SERVICE_QUERY="${HERO_SMS_SERVICE_QUERY:-}"
SMS_PRICE_RANKING="${HERO_SMS_PRICE_RANKING:-price_asc}"
LIST_SMS_SERVICES=false
PROXY_COUNT=0
declare -a PROXIES=()

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
            echo "Usage: $0 [--all | --index N] [--accounts-file FILE] [--signup] [--proxy-file FILE] [--proxy-scheme SCHEME] [--max-proxy-attempts N] [--browser-engine auto|puppeteer|playwright] [--state-file FILE] [--resume] [--reset-state] [--names-file FILE] [--sms-services CSV] [--sms-service-prefix PREFIX] [--sms-service-query TEXT] [--sms-price-ranking MODE] [--list-sms-services]"
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

if [[ "$STATE_FILE" != /* ]]; then
    STATE_FILE="$PWD/$STATE_FILE"
fi

if [ -n "$NAMES_FILE" ] && [[ "$NAMES_FILE" != /* ]]; then
    NAMES_FILE="$PWD/$NAMES_FILE"
fi

cleanup_prepared_accounts() {
    stop_cli_auth
    if [ "$TEMP_PREPARED_ACCOUNTS" = true ] && [ -n "$PREPARED_ACCOUNTS_FILE" ]; then
        rm -f "$PREPARED_ACCOUNTS_FILE" 2>/dev/null || true
    fi
}
trap cleanup_prepared_accounts EXIT

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

case "${ACCOUNTS_FILE##*.}" in
    json)
        if [ -n "$NAMES_FILE" ]; then
            if [ ! -f "$NAMES_FILE" ]; then
                echo "Error: names file not found at $NAMES_FILE"
                exit 1
            fi
            PREPARED_ACCOUNTS_FILE="/tmp/codex-accounts-prepared-$$.json"
            echo "Preparing accounts from json format with names file: $ACCOUNTS_FILE"
            node "$SCRIPT_DIR/prepare-accounts.js" \
                --input "$ACCOUNTS_FILE" \
                --output "$PREPARED_ACCOUNTS_FILE" \
                --names-file "$NAMES_FILE"
            TEMP_PREPARED_ACCOUNTS=true
        else
            PREPARED_ACCOUNTS_FILE="$ACCOUNTS_FILE"
        fi
        ;;
    *)
        PREPARED_ACCOUNTS_FILE="/tmp/codex-accounts-prepared-$$.json"
        echo "Preparing accounts from text format: $ACCOUNTS_FILE"
        PREPARE_ARGS=(--input "$ACCOUNTS_FILE" --output "$PREPARED_ACCOUNTS_FILE")
        if [ -n "$NAMES_FILE" ]; then
            if [ ! -f "$NAMES_FILE" ]; then
                echo "Error: names file not found at $NAMES_FILE"
                exit 1
            fi
            PREPARE_ARGS+=(--names-file "$NAMES_FILE")
        fi
        node "$SCRIPT_DIR/prepare-accounts.js" "${PREPARE_ARGS[@]}"
        TEMP_PREPARED_ACCOUNTS=true
        ;;
esac

# Get account count
ACCOUNT_COUNT=$(jq length "$PREPARED_ACCOUNTS_FILE")
init_state_file
state_write_meta

echo "Using accounts file: $ACCOUNTS_FILE"
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
echo "State file: $STATE_FILE"
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
            output="$(cat "$CURRENT_AUTH_LOG" 2>/dev/null || true)"
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

    if [ "$RESUME_MODE" = true ]; then
        LAST_STATE_STATUS="$(state_get_status "$ACCOUNT_EMAIL")"
        if [ "$LAST_STATE_STATUS" = "success" ]; then
            echo "↷ Skipping account #$idx (already successful in state file)"
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
        if [ "$PROXY_COUNT" -gt 0 ]; then
            proxy_idx=$(( (idx + attempt) % PROXY_COUNT ))
            SELECTED_PROXY="${PROXIES[$proxy_idx]}"
            echo "Proxy #$proxy_idx: $SELECTED_PROXY (scheme: $PROXY_SCHEME)"
        else
            echo "Proxy: disabled"
        fi

        state_update_account "$ACCOUNT_EMAIL" "running" "attempt_started" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""

        stop_cli_auth
        sleep 1

        CURRENT_AUTH_LOG="/tmp/codex-cli-auth-${idx}-${attempt}-${RUN_TAG}.log"
        rm -f "$CURRENT_AUTH_LOG" 2>/dev/null || true

        echo "Starting cli-proxy-api for account #$idx..."
        start_cli_auth "$CURRENT_AUTH_LOG"
        sleep 2

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
            stop_cli_auth
            continue
        fi
        echo "Auth URL: ${LOGIN_URL:0:80}..."

        echo "Waiting for port 1455..."
        if ! wait_for_port_1455; then
            echo "✗ Port 1455 is not ready"
            ACCOUNT_REASON="local_callback_port_unavailable"
            state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""
            stop_cli_auth
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
                if [ -n "$SAVED_AUTH_FILE" ]; then
                    echo "Auth file: $SAVED_AUTH_FILE"
                fi
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
                stop_cli_auth
                break
            fi
        else
            echo "✗ Failed to get callback URL for account #$idx (attempt $((attempt + 1)), exit=$LOGIN_EXIT, reason=${RESULT_REASON:-unknown})"
            state_update_account "$ACCOUNT_EMAIL" "failed" "$ACCOUNT_REASON" "$idx" "$((attempt + 1))" "$SELECTED_PROXY" ""
        fi

        stop_cli_auth
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

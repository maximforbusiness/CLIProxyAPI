#!/bin/bash

# Ollama.com Auto - Batch account authorization
# Usage:
#   ollama-auto.sh [--all | --index N] [--accounts-file FILE] \
#                  [--proxy-file FILE] [--proxy-scheme SCHEME] \
#                  [--env-file FILE] [--no-env-file] \
#                  [--browser-engine auto|puppeteer|playwright] \
#                  [--state-file FILE] [--used-file FILE] \
#                  [--resume] [--reset-state] \
#                  [--sms-service CODE] [--sms-countries CSV] \
#                  [--email-code CODE]
#
# Options:
#   --all                  : Process all accounts in accounts file
#   --index N              : Process only account at index N (0-based)
#   --accounts-file FILE   : Accounts file (.json or text)
#   --proxy-file FILE      : One proxy per line
#   --proxy-scheme SCHEME  : http|https|socks5|socks4 (default: http)
#   --env-file FILE        : Load env profile from FILE
#   --no-env-file          : Disable automatic env profile discovery
#   --browser-engine       : Browser launcher preference (default: auto)
#   --state-file FILE      : JSON state file for progress tracking
#   --used-file FILE       : Flat-file registry for successful accounts
#   --resume               : Skip accounts already marked success
#   --reset-state          : Reset state file before run
#   --sms-service CODE     : SMS service code (default: dr for "other")
#   --sms-countries CSV    : Country codes (default: 44 for UK)
#   --email-code CODE      : Email verification code (for testing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="$(cd "$PROJECT_DIR/.." && pwd)"

LOADED_ENV_FILE=""
ENV_FILE_CLI=""
NO_AUTO_ENV_FILE=false

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
    source "$env_file" || load_rc=$?
    set +a
    if [ "$load_rc" -ne 0 ]; then
        echo "Error: failed to load env file $env_file"
        exit 1
    fi
    LOADED_ENV_FILE="$env_file"
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
elif [ -n "${OLLAMA_AUTO_ENV_FILE:-}" ]; then
    load_env_file "$OLLAMA_AUTO_ENV_FILE"
elif [ "$NO_AUTO_ENV_FILE" != true ]; then
    for default_env_file in \
        "$SCRIPT_DIR/ollama-auto.env" \
        "$RUNTIME_DIR/acc-gen/ollama-auto.env" \
        "$PROJECT_DIR/.ollama-auto.env"; do
        if [ -f "$default_env_file" ]; then
            load_env_file "$default_env_file"
            break
        fi
    done
fi

# Default configuration
ACCOUNTS_FILE="${OLLAMA_ACCOUNTS_FILE:-$SCRIPT_DIR/ollama-accounts.json}"
STATE_FILE="${OLLAMA_STATE_FILE:-$SCRIPT_DIR/ollama-auto-state.json}"
USED_FILE="${OLLAMA_USED_FILE:-$SCRIPT_DIR/ollama-used.txt}"
BROWSER_ENGINE="${OLLAMA_BROWSER_ENGINE:-auto}"
BROWSER_BACKEND="${OLLAMA_BROWSER_BACKEND:-local}"
SMS_SERVICE="${OLLAMA_SMS_SERVICE:-dr}"
SMS_COUNTRIES="${OLLAMA_SMS_COUNTRIES:-44}"
EMAIL_CODE="${OLLAMA_EMAIL_CODE:-}"
PROCESS_ALL=false
ACCOUNT_INDEX=""
PROXY_FILE=""
PROXY_SCHEME="${OLLAMA_PROXY_SCHEME:-http}"
RESUME=false
RESET_STATE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)
            PROCESS_ALL=true
            shift
            ;;
        --index)
            ACCOUNT_INDEX="$2"
            shift 2
            ;;
        --accounts-file)
            ACCOUNTS_FILE="$2"
            shift 2
            ;;
        --proxy-file)
            PROXY_FILE="$2"
            shift 2
            ;;
        --proxy-scheme)
            PROXY_SCHEME="$2"
            shift 2
            ;;
        --browser-engine)
            BROWSER_ENGINE="$2"
            shift 2
            ;;
        --browser-backend)
            BROWSER_BACKEND="$2"
            shift 2
            ;;
        --state-file)
            STATE_FILE="$2"
            shift 2
            ;;
        --used-file)
            USED_FILE="$2"
            shift 2
            ;;
        --resume)
            RESUME=true
            shift
            ;;
        --reset-state)
            RESET_STATE=true
            shift
            ;;
        --sms-service)
            SMS_SERVICE="$2"
            shift 2
            ;;
        --sms-countries)
            SMS_COUNTRIES="$2"
            shift 2
            ;;
        --email-code)
            EMAIL_CODE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--all | --index N] [options]"
            echo "Run 'ollama-auto.sh --help' for full options"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Reset state if requested
if [ "$RESET_STATE" = true ]; then
    echo "Resetting state file..."
    echo '{}' > "$STATE_FILE"
fi

# Initialize state file
if [ ! -f "$STATE_FILE" ]; then
    echo '{"processed":[],"success":[],"failed":[]}' > "$STATE_FILE"
fi

# Check accounts file
if [ ! -f "$ACCOUNTS_FILE" ]; then
    echo "Error: Accounts file not found: $ACCOUNTS_FILE"
    echo "Create accounts.json with format:"
    echo '['
    echo '  {"email": "user@example.com", "password": "Pass123!", "name": "User"}'
    echo ']'
    exit 1
fi

# Check Hero-SMS API key
if [ -z "${HERO_SMS_API_KEY:-}" ]; then
    echo "Warning: HERO_SMS_API_KEY not set"
    echo "SMS verification will fail without it"
fi

# Export environment variables for Node.js script
export OLLAMA_ACCOUNTS_FILE="$ACCOUNTS_FILE"
export OLLAMA_BROWSER_ENGINE="$BROWSER_ENGINE"
export OLLAMA_SMS_SERVICE="$SMS_SERVICE"
export OLLAMA_SMS_COUNTRIES="$SMS_COUNTRIES"
export OLLAMA_EMAIL_CODE="$EMAIL_CODE"
export OLLAMA_ALLOW_MANUAL_HUMAN_CHECK="${OLLAMA_ALLOW_MANUAL_HUMAN_CHECK:-false}"

if [ -n "$PROXY_FILE" ] && [ -f "$PROXY_FILE" ]; then
    echo "Proxy file: $PROXY_FILE"
    # Proxy handling would go here (similar to codex-auto.sh)
fi

echo "============================================"
echo "Ollama Auto Authorization"
echo "============================================"
echo "Accounts file: $ACCOUNTS_FILE"
echo "State file: $STATE_FILE"
echo "Browser backend: $BROWSER_BACKEND"
echo "Browser engine: $BROWSER_ENGINE"
echo "SMS service: $SMS_SERVICE"
echo "SMS countries: $SMS_COUNTRIES"
echo "============================================"
echo ""

LOGIN_SCRIPT="$SCRIPT_DIR/ollama-login.js"
if [ "$BROWSER_BACKEND" = "browserapi" ]; then
    LOGIN_SCRIPT="$SCRIPT_DIR/ollama-login-browserapi.js"
fi

# Run single account or all accounts
if [ -n "$ACCOUNT_INDEX" ]; then
    echo "Processing account index: $ACCOUNT_INDEX"
    node "$LOGIN_SCRIPT" "$ACCOUNT_INDEX"
elif [ "$PROCESS_ALL" = true ]; then
    echo "Processing all accounts..."
    # Count accounts
    if [[ "$ACCOUNTS_FILE" == *.json ]]; then
        ACCOUNT_COUNT=$(jq 'length' "$ACCOUNTS_FILE" 2>/dev/null || echo "0")
    else
        ACCOUNT_COUNT=$(wc -l < "$ACCOUNTS_FILE" || echo "0")
    fi
    
    echo "Total accounts: $ACCOUNT_COUNT"
    
    for ((i=0; i<ACCOUNT_COUNT; i++)); do
        echo ""
        echo "========================================"
        echo "Processing account $((i+1))/$ACCOUNT_COUNT"
        echo "========================================"
        
        # Check if already processed (resume mode)
        if [ "$RESUME" = true ]; then
            if jq -e ".success[] | select(.index == $i)" "$STATE_FILE" > /dev/null 2>&1; then
                echo "Skipping account $i (already successful)"
                continue
            fi
        fi
        
        # Run login
        if node "$LOGIN_SCRIPT" "$i"; then
            echo "Account $i: SUCCESS"
            # Update state file
            jq ".success += [{\"index\": $i, \"timestamp\": \"$(date -Iseconds)\"}]" "$STATE_FILE" > "${STATE_FILE}.tmp"
            mv "${STATE_FILE}.tmp" "$STATE_FILE"
            # Add to used file
            echo "$i" >> "$USED_FILE"
        else
            echo "Account $i: FAILED"
            jq ".failed += [{\"index\": $i, \"timestamp\": \"$(date -Iseconds)\"}]" "$STATE_FILE" > "${STATE_FILE}.tmp"
            mv "${STATE_FILE}.tmp" "$STATE_FILE"
        fi
        
        # Cooldown between accounts
        if [ $i -lt $((ACCOUNT_COUNT - 1)) ]; then
            echo "Cooldown 30 seconds..."
            sleep 30
        fi
    done
else
    echo "Processing single account (index 0)"
    node "$LOGIN_SCRIPT" 0
fi

echo ""
echo "============================================"
echo "Batch processing completed"
echo "============================================"
echo "Results: $SCRIPT_DIR/ollama-results.json"
echo "State: $STATE_FILE"

#!/bin/bash

# Wrapper for Firstmail batch authorization using the unified codex-auto flow.
# Keeps backward-compatible entrypoint: codex-signup-auto.sh [--all | --index N]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_ACC_GEN_DIR="$PROJECT_DIR/../acc-gen"
ACCOUNTS_FILE="${CODEX_FIRSTMAIL_ACCOUNTS_FILE:-}"
if [ -z "$ACCOUNTS_FILE" ]; then
    if [ -f "$SCRIPT_DIR/firstmail-1000-26.04.05.txt" ]; then
        ACCOUNTS_FILE="$SCRIPT_DIR/firstmail-1000-26.04.05.txt"
    elif [ -f "$SCRIPT_DIR/firstmail-1000-26.04.05.json" ]; then
        ACCOUNTS_FILE="$SCRIPT_DIR/firstmail-1000-26.04.05.json"
    elif [ -f "$RUNTIME_ACC_GEN_DIR/firstmail-1000-26.04.05.txt" ]; then
        ACCOUNTS_FILE="$RUNTIME_ACC_GEN_DIR/firstmail-1000-26.04.05.txt"
    elif [ -f "$RUNTIME_ACC_GEN_DIR/firstmail-1000-26.04.05.json" ]; then
        ACCOUNTS_FILE="$RUNTIME_ACC_GEN_DIR/firstmail-1000-26.04.05.json"
    elif [ -f "$RUNTIME_ACC_GEN_DIR/firstmail-accounts.json" ]; then
        ACCOUNTS_FILE="$RUNTIME_ACC_GEN_DIR/firstmail-accounts.json"
    else
        ACCOUNTS_FILE="$SCRIPT_DIR/firstmail-accounts.json"
    fi
fi

if [ ! -f "$ACCOUNTS_FILE" ]; then
    echo "Error: accounts file not found at $ACCOUNTS_FILE"
    echo "Hint: set CODEX_FIRSTMAIL_ACCOUNTS_FILE=/absolute/path/to/list.txt|json"
    exit 1
fi

echo "Firstmail source file: $ACCOUNTS_FILE"

exec bash "$SCRIPT_DIR/codex-auto.sh" --accounts-file "$ACCOUNTS_FILE" --signup "$@"

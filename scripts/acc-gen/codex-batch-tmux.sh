#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="$(cd "$PROJECT_DIR/.." && pwd)"

SESSION_NAME="${CODEX_BATCH_SESSION:-codex-batch}"
ENV_FILE="${CODEX_BATCH_ENV_FILE:-$RUNTIME_DIR/acc-gen/codex-auto.env}"
AUTO_SCRIPT="$SCRIPT_DIR/codex-auto.sh"
LOG_DIR="${CODEX_BATCH_LOG_DIR:-$RUNTIME_DIR/acc-gen/logs}"
CURRENT_LOG_LINK="$LOG_DIR/codex-batch-current.log"

usage() {
    cat <<USAGE
Usage: $(basename "$0") <start|stop|restart|status|logs|attach>

Environment overrides:
  CODEX_BATCH_SESSION    tmux session name (default: codex-batch)
  CODEX_BATCH_ENV_FILE   env profile path (default: $RUNTIME_DIR/acc-gen/codex-auto.env)
  CODEX_BATCH_LOG_DIR    logs directory (default: $RUNTIME_DIR/acc-gen/logs)
USAGE
}

ensure_tmux() {
    if ! command -v tmux >/dev/null 2>&1; then
        echo "Error: tmux is not installed"
        exit 1
    fi
}

ensure_paths() {
    if [ ! -f "$AUTO_SCRIPT" ]; then
        echo "Error: script not found: $AUTO_SCRIPT"
        exit 1
    fi
    if [ ! -f "$ENV_FILE" ]; then
        echo "Error: env file not found: $ENV_FILE"
        exit 1
    fi
    mkdir -p "$LOG_DIR"
}

is_running() {
    tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

start_session() {
    ensure_tmux
    ensure_paths

    if is_running; then
        echo "Session already running: $SESSION_NAME"
        echo "Use: $0 status"
        return 0
    fi

    local log_file
    log_file="$LOG_DIR/codex-batch-$(date -u +%Y%m%d-%H%M%S).log"

    tmux new-session -d -s "$SESSION_NAME" \
        "bash '$AUTO_SCRIPT' --env-file '$ENV_FILE' --all >> '$log_file' 2>&1"

    ln -sfn "$log_file" "$CURRENT_LOG_LINK"

    echo "Started tmux session: $SESSION_NAME"
    echo "Log file: $log_file"
    echo "Attach: tmux attach -t $SESSION_NAME"
}

stop_session() {
    ensure_tmux
    if ! is_running; then
        echo "Session is not running: $SESSION_NAME"
        return 0
    fi
    tmux kill-session -t "$SESSION_NAME"
    echo "Stopped session: $SESSION_NAME"
}

status_session() {
    ensure_tmux
    if is_running; then
        echo "RUNNING: $SESSION_NAME"
        tmux list-sessions | grep "^${SESSION_NAME}:" || true
        tmux list-panes -t "$SESSION_NAME" -F 'pane_pid=#{pane_pid} pane_current_command=#{pane_current_command}' || true
        if [ -L "$CURRENT_LOG_LINK" ] || [ -f "$CURRENT_LOG_LINK" ]; then
            echo "Current log: $(readlink -f "$CURRENT_LOG_LINK" 2>/dev/null || echo "$CURRENT_LOG_LINK")"
        fi
    else
        echo "STOPPED: $SESSION_NAME"
    fi
}

logs_session() {
    ensure_paths
    if [ -L "$CURRENT_LOG_LINK" ] || [ -f "$CURRENT_LOG_LINK" ]; then
        tail -f "$CURRENT_LOG_LINK"
        return 0
    fi

    local latest
    latest="$(ls -1t "$LOG_DIR"/codex-batch-*.log 2>/dev/null | head -n 1 || true)"
    if [ -z "$latest" ]; then
        echo "No logs found in: $LOG_DIR"
        return 1
    fi

    tail -f "$latest"
}

attach_session() {
    ensure_tmux
    if ! is_running; then
        echo "Session is not running: $SESSION_NAME"
        return 1
    fi
    exec tmux attach -t "$SESSION_NAME"
}

ACTION="${1:-status}"
case "$ACTION" in
    start)
        start_session
        ;;
    stop)
        stop_session
        ;;
    restart)
        stop_session
        start_session
        ;;
    status)
        status_session
        ;;
    logs)
        logs_session
        ;;
    attach)
        attach_session
        ;;
    *)
        usage
        exit 1
        ;;
esac

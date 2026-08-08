#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

rm -f /web/ai-tools.su/gpt-api/acc-gen/codex-auto-state.json /web/ai-tools.su/gpt-api/acc-gen/codex/codex-auto-state.json 2>/dev/null || true

for i in $(seq 0 18); do
    echo "========================================"
    echo "STARTING BATCH ACCOUNT #$i / 18"
    echo "========================================"
    echo '{}' > /web/ai-tools.su/gpt-api/acc-gen/codex-proxy-cooldown.json 2>/dev/null || true
    echo '{}' > "$SCRIPT_DIR/codex-proxy-cooldown.json" 2>/dev/null || true
    rm -f /web/ai-tools.su/acc-gen/codex-auto.lock /web/ai-tools.su/gpt-api/acc-gen/codex-auto.lock 2>/dev/null || true

    xvfb-run -a ./codex-auto.sh --index "$i" --signup --reset-state || true
    sleep 2
done

echo "Batch completed!"

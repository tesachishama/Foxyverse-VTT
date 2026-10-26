#!/usr/bin/env bash
# Build the image, start it on a throwaway volume, run the smoke test, check shutdown time and persistence.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=foxy-smoke; VOL=foxy-smoke-data; PORT=${PORT:-3999}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker build -t foxyverse-vtt:smoke .
docker volume create "$VOL" >/dev/null
docker run -d --name "$NAME" --init -p "$PORT:3000" -v "$VOL:/data" foxyverse-vtt:smoke >/dev/null
node scripts/smoke.mjs "http://127.0.0.1:$PORT" || { docker logs "$NAME"; exit 1; }
START=$(date +%s); docker stop "$NAME" >/dev/null; ELAPSED=$(( $(date +%s) - START ))
[ "$ELAPSED" -lt 8 ] || { echo "container took ${ELAPSED}s to stop (should be instant)"; exit 1; }
docker start "$NAME" >/dev/null; sleep 3
curl -fsS "http://127.0.0.1:$PORT/api/me" | grep -q '"firstRun":false' || { echo "data did not persist across restart"; docker logs "$NAME"; exit 1; }
echo "Docker smoke test passed (stop took ${ELAPSED}s, data persisted across restart)."

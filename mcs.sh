#!/usr/bin/env bash
# On-demand runner for the smart-recipe fork (arm64, macOS) — no cwd mounting.
# The CLI always runs in /app; host files given as arguments are staged
# read-only into /files and rewritten to container paths automatically.
#
# examples:  ./mcs.sh login-browser --device mc --save
#            ./mcs.sh create "https://example.com/recipe"
#            ./mcs.sh import-photo cookbook-page.jpg page2.jpg
set -euo pipefail

IMAGE=julvo712/smart-recipe:ollama
STATE_DIR="$HOME/.smart-recipe"
STAGE="$(mktemp -d /tmp/mcs-stage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

args=()
declare -A staged_names
for arg in "$@"; do
  if [[ -f "$arg" ]]; then
    base="$(basename "$arg")"
    if [[ -n "${staged_names[$base]:-}" ]]; then
      echo "ERROR: duplicate file name '$base' — rename one of the files (staging rewrites paths to /files/<basename>)." >&2
      exit 2
    fi
    staged_names[$base]=1
    cp -f "$arg" "$STAGE/$base"
    args+=("/files/$base")
  else
    args+=("$arg")
  fi
done

docker run --rm -it \
  -v "$STATE_DIR:/root/.smart-recipe" \
  -v "$STAGE:/files:ro" \
  -e OPENAI_API_KEY -e OPENAI_BASE_URL -e OPENAI_MODEL -e OPENAI_VL_MODEL \
  -e OPENAI_REASONING_EFFORT -e MC_COOKIE -e MC_LOGIN -e MC_PW \
  -e MC_LOCALE -e TARGET_DEVICE -e MC_HAS_FOOD_PROCESSOR -e SAVE_SETTINGS \
  -w /app \
  "$IMAGE" "${args[@]}"
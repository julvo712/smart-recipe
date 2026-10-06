#!/usr/bin/env bash
# On-demand runner for the smart-recipe fork (arm64, macOS; bash 3.2 compatible).
# The CLI always runs in /app; existing host files given as arguments are staged
# read-only into /files and rewritten to container paths automatically.
#
# examples:  ./mcs.sh login-cookie                      (one-time Lidl Plus cookie)
#            ./mcs.sh create "https://example.com/recipe"
#            ./mcs.sh import-photo cookbook-page.jpg page2.jpg
set -euo pipefail

IMAGE=julvo712/smart-recipe:ollama
STATE_DIR="$HOME/.smart-recipe"
CONFIG_FILE="$STATE_DIR/config"
mkdir -p "$STATE_DIR"
[[ -d "$CONFIG_FILE" ]] && { echo "ERROR: $CONFIG_FILE is a directory (from an earlier mcs.sh design); move it aside." >&2; exit 2; }
touch "$CONFIG_FILE"

STAGE="$(mktemp -d "$STATE_DIR/mcs-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

if [[ "${1:-}" == "login-cookie" ]]; then
  shift || true
  cookie=""
  if [[ "${1:-}" != "" ]]; then
    cookie="$(cat "$1")"
  elif command -v pbpaste >/dev/null 2>&1 && [[ -n "$(pbpaste)" ]]; then
    cookie="$(pbpaste)"
    echo "Using cookie from clipboard ($(printf '%s' "$cookie" | wc -c | tr -d ' ') chars)."
  else
    printf 'Paste the full Cookie header (or copy it to the clipboard first and rerun `mcs.sh login-cookie`): '
    read -r cookie
  fi
  cookie="$(printf '%s' "$cookie" | tr -d '\n\r' | sed 's/[[:space:]]*$//')"
  [ -n "$cookie" ] || { echo "No cookie given." >&2; exit 2; }
  config="$STATE_DIR/config"
  touch "$config"
  grep -v '^MC_COOKIE=' "$config" > "$config.tmp" || true
  printf 'MC_COOKIE=%s\n' "$cookie" >> "$config.tmp"
  mv "$config.tmp" "$config"
  echo "Saved MC_COOKIE ($(printf '%s' "$cookie" | wc -c | tr -d ' ') chars) to $config. Run ./mcs.sh doctor --device mc to verify."
  exit 0
fi

args=()
name_list="$STAGE/names.txt"
: > "$name_list"
stage_files=false
case "${1:-}" in
  import-photo|create-photo|import-file|create-file) stage_files=true ;;
esac
for arg in "$@"; do
  if [[ "$stage_files" == true && -f "$arg" ]]; then
    base="$(basename "$arg")"
    if grep -Fxq -- "$base" "$name_list"; then
      echo "ERROR: duplicate file name '$base' — rename one of the files (staging rewrites paths to /files/<basename>)." >&2
      exit 2
    fi
    printf '%s\n' "$base" >> "$name_list"
    case "$arg" in
      *.[Hh][Ee][Ii][Cc]|*.[Hh][Ee][Ii][Ff])
        sips -s format jpeg -Z 1600 "$arg" --out "$STAGE/${base%.*}.jpg" >/dev/null
        args+=("/files/${base%.*}.jpg")
        ;;
      *)
        cp -f "$arg" "$STAGE/$base"
        args+=("/files/$base")
        ;;
    esac
  else
    args+=("$arg")
  fi
done

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "Image $IMAGE missing — build first: docker build -t $IMAGE ." >&2
  exit 2
}
tty_flags=(-i)
if [[ -t 0 && -t 1 ]]; then tty_flags=(-it); fi

docker run --rm "${tty_flags[@]}" \
  -v "$CONFIG_FILE:/root/.smart-recipe" \
  -v "$STAGE:/files:ro" \
  -e OPENAI_API_KEY -e OPENAI_BASE_URL -e OPENAI_MODEL -e OPENAI_VL_MODEL \
  -e OPENAI_REASONING_EFFORT -e MC_COOKIE -e MC_LOGIN -e MC_PW \
  -e MC_LOCALE -e MC_HAS_FOOD_PROCESSOR -e TARGET_DEVICE -e SAVE_SETTINGS \
  -e TM_COOKIE -e TM_COOKIES -e TM_LOGIN -e TM_PW -e TM_VERSION -e TM_LOCALE \
  -e LOG_LEVEL \
  "$IMAGE" ${args[@]+"${args[@]}"}
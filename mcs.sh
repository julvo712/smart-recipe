#!/usr/bin/env bash
# Wrapper for on-demand runs of the smart-recipe fork in Docker (arm64, macOS).
# Usage:  mcs.sh <smart-recipe args...>       e.g. mcs.sh create "https://..." --dry-run
#         mcs.sh login                        one-time Lidl Plus login (persists cookie)
set -euo pipefail

IMAGE=julvo712/smart-recipe:ollama
STATE_DIR="$HOME/.smart-recipe"

# photos are passed through as paths; only ~/.smart-recipe and cwd are mounted
docker run --rm -it \
  -v "$STATE_DIR:/root/.smart-recipe" \
  -v "$PWD:/work" -w /work \
  -e OPENAI_API_KEY -e OPENAI_BASE_URL -e OPENAI_MODEL -e OPENAI_VL_MODEL \
  -e OPENAI_REASONING_EFFORT -e MC_COOKIE -e MC_LOCALE -e TARGET_DEVICE \
  -e MC_HAS_FOOD_PROCESSOR -e SAVE_SETTINGS \
  "$IMAGE" "$@"

# examples
#   ./mcs.sh login-browser --device mc --save      one-time Lidl Plus login (persists cookie)
#   ./mcs.sh create "https://example.com/recipe"   web recipe -> draft
#   ./mcs.sh import-photo cookbook-page.jpg        cookbook photo -> draft
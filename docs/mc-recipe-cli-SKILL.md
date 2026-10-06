---
name: mc-recipe-cli
description: Use when the user wants to import, convert, or generate cooking recipes for the Monsieur Cuisine Smart (MC3.0 / Lidlomix) from a recipe URL, cookbook photo, text, or AI-generated content into guided step-by-step recipes; also when mentioning Monsieur Cuisine, guided cooking, smart cooker drafts, or errors from the smart-recipe CLI / mcs.sh.
version: 0.1.0
---

# Monsieur Cuisine Smart recipe CLI (fork: julvo712/smart-recipe)

## What this is

A CLI (`smart-recipe`, wrapped for Docker on the user's Mac via `mcs.sh`) that turns
arbitrary recipe sources into **device-native guided cooking drafts** for the
Monsieur Cuisine Smart: ingredients with scale steps, cooked steps with real
temperature/speed/time device programs, look-ahead prep steps. Drafts upload to the
user's Monsieur Cuisine (Lidl Plus) account and cook guided on the device.

- Fork repo: https://github.com/julvo712/smart-recipe (branch `ollama`)
- Upstream: https://github.com/gerkensm/smart-recipe
- Runs in Docker (arm64, node:22); state is only `~/.smart-recipe/config` (a dotenv
  file holding `MC_COOKIE` and saved settings) plus a per-run staging dir.
- Default LLM: Ollama cloud `glm-5.3-flash` with reasoning effort `high`
  (`OPENAI_BASE_URL=https://ollama.com/v1` is the code default; OpenAI-compatible).

## Prerequisite state (check before running anything)

1. Repo checked out locally at branch `ollama` (assume `~/smart-recipe` unless told otherwise).
2. Docker image exists: `docker image inspect julvo712/smart-recipe:ollama` — if missing:
   `cd ~/smart-recipe && docker build -t julvo712/smart-recipe:ollama .` (rebuild after EVERY
   `git pull` that touches code — dist changes only ship via rebuild).
3. Session cookie present: `grep MC_COOKIE ~/.smart-recipe/config`. If absent or stale:
   user copies the `Cookie:` request header from DevTools (any request to
   `www.monsieur-cuisine.com` while logged in) to the clipboard, then runs
   `./mcs.sh login-cookie` (reads the macOS clipboard, no paste, no length limit).
   Verify with `./mcs.sh doctor --device mc` → must show `Auth check: ok`.
4. Env in the shell (e.g. `~/.zshrc`): `OPENAI_API_KEY` (Ollama cloud key),
   `OPENAI_VL_MODEL=glm-5.3-flash` (for photo transcription), optional `MC_LOCALE`.

`./mcs.sh doctor --device mc` is always the first move after any doubt — it shows
which piece is missing (key / cookie / auth) without doing any write.

## Core commands (via the wrapper)

```bash
./mcs.sh create "https://<recipe-url>"          # web page → guided draft
./mcs.sh create "https://…" --dry-run           # generate + display, no upload
./mcs.sh import-photo cookbook.jpg              # cookbook photo → transcription → draft
./mcs.sh import-photo p1.heic p2.jpg p3.jpg     # multiple pages = recipe order; HEIC auto-converted
./mcs.sh create-file rezept-text.md             # local text/markdown → draft (also: create-stdin)
./mcs.sh recipes --device mc                    # list drafts in the account
./mcs.sh doctor --device mc                     # health check
./mcs.sh login-cookie                           # (re-)capture session cookie
```

Wrapper magic: every argument that names an existing host file is staged read-only into
`/files` inside the container and rewritten automatically; you never mount anything yourself.
Always run `mcs.sh` from the repo directory (`cd ~/smart-recipe`).

## Semantics an agent must respect

- The upload creates a **draft** (private); it appears under "Meine Rezepte" on the site/app.
  The user reviews it there and cooks it guided. Nothing goes public automatically — do not
  publish without explicit user instruction.
- Generated recipes are AI drafts, not tested recipes: show/tell the user to review
  quantities, times, and modes before cooking. Never present a draft as safety-checked.
- Device limits are enforced twice (schema + prompt): 3 L jug, scale steps only ≥ ~20 g
  (use spoons/pinches below), kneading ≤ 1000 g flour, browning temperature clamped,
  instruction steps must carry the user-facing text because auto modes show titles only.
- One import ≈ 1 large LLM call (+ up to 3 schema-repair rounds, + 1 vision call for photos)
  on the user's Ollama cloud budget — batch related questions, don't loop imports casually.

## Troubleshooting (pattern, not guessing)

- `Monsieur Cuisine API response shape changed` from `assertVendorResponse`: the vendor
  drifted a payload shape. The failure names the endpoint and shows the asserted `body`.
  Fix = tolerance unwrap in `src/mc/client.ts` (remember `getRecord` never returns array
  children — use `getArray`), a regression test pinning the LIVE shape (capture the real
  payload first), then commit → user rebuilds the image. Known shapes (live-verified
  2026-10): media list = `{code, message, data:{media:[...]}}`; during processing
  `data.media` is `[]` (treat as empty, keep polling); draft list has `data.recipes[]`.
- 401 on proxy calls: session expired → `./mcs.sh login-cookie` fresh.
- "OpenAI key: missing" in doctor: the key is not exported in the invoking shell (env
  passthrough only happens via `-e` flags) — set it in `~/.zshrc` and `source ~/.zshrc`.
- Stale behavior despite a fix: almost always the image was not rebuilt after `git pull`.
- Never work around shape errors by weakening the recipe/device schema.

## Fork maintenance

Keep the diff against upstream small (currently: 4 production files + photo module
+ wrapper/Docker/docs). Monthly: `git fetch upstream && git rebase upstream/main`;
conflicts should only ever appear in those files — re-review any upstream prompt/schema
change before completing the rebase. The full setup/usage documentation lives in the
repo README section "Ollama setup".
#!/usr/bin/env bash
#
# Fetch a sample VRM model into public/images/models/avatar.vrm so the digital-human
# dock has a model to render out of the box (no manual upload needed).
#
# The default URL points at the official three-vrm sample (VRM 1.0, MIT-friendly).
# NOTE: the classic "AliciaSolid.vrm" is no longer served from a stable raw URL,
# so we default to a verified three-vrm sample. To use a different model (e.g. a
# VRM you exported, or AliciaSolid from a release), set SAMPLE_VRM_URL:
#
#   SAMPLE_VRM_URL="https://.../AliciaSolid.vrm" ./scripts/fetch-sample-vrm.sh
#
# Any file named avatar.vrm under public/images/models/ is picked up automatically by
# the fallback loader (see src/core/avatar/constants.ts -> FALLBACK_MODEL_URL).
set -euo pipefail

# Resolve the frontend root (parent of this script's directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODELS_DIR="${FRONTEND_ROOT}/public/images/models"
TARGET="${MODELS_DIR}/avatar.vrm"

# Verified official three-vrm sample (VRM 1.0).
SAMPLE_VRM_URL="${SAMPLE_VRM_URL:-https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm}"

mkdir -p "${MODELS_DIR}"

if [[ -f "${TARGET}" && "${FORCE:-0}" != "1" ]]; then
  echo "✔ ${TARGET} already exists; skipping (set FORCE=1 to overwrite)."
  exit 0
fi

echo "↓ Downloading sample VRM from:"
echo "  ${SAMPLE_VRM_URL}"
echo "  -> ${TARGET}"

if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --retry-delay 2 -o "${TARGET}" "${SAMPLE_VRM_URL}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${TARGET}" "${SAMPLE_VRM_URL}"
else
  echo "✘ Neither curl nor wget is available; cannot download." >&2
  exit 1
fi

# Sanity check: a real VRM/glTF container starts with the "glTF" magic bytes.
if ! head -c 4 "${TARGET}" | grep -q 'glTF'; then
  echo "✘ Downloaded file does not look like a VRM (missing glTF magic). Aborting." >&2
  rm -f "${TARGET}"
  exit 1
fi

SIZE=$(wc -c < "${TARGET}" | tr -d ' ')
echo "✔ Saved ${TARGET} (${SIZE} bytes). Restart 'make dev' / 'pnpm dev' to see it."

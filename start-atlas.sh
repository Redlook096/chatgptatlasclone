#!/usr/bin/env bash
set -euo pipefail

ATLAS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATLAS_APPIMAGE="$ATLAS_ROOT/dist/Atlas Desk-0.1.0.AppImage"
ATLAS_UNPACKED="$ATLAS_ROOT/dist/linux-unpacked/atlas-desk"

if [[ -x "$ATLAS_APPIMAGE" ]]; then
  exec "$ATLAS_APPIMAGE" "$@"
fi

if [[ -x "$ATLAS_UNPACKED" ]]; then
  exec "$ATLAS_UNPACKED" "$@"
fi

cd "$ATLAS_ROOT"
if [[ ! -x "$ATLAS_ROOT/node_modules/.bin/electron" ]]; then
  npm ci
fi
exec npm run start -- "$@"

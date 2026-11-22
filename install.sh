#!/usr/bin/env bash
# Install the turn-keepalive plugin into a DSH profile.
#
#   ./install.sh [profile]     # default: $DSH_PROFILE or dsh-tui
#
# Copies plugin/ into <DSH_HOME>/profiles/<profile>/plugins/turn-keepalive and
# appends the loader row to cordis.patch.yml once. Idempotent; re-running
# refreshes the copied files and leaves the patch alone.
set -euo pipefail

PROFILE="${1:-${DSH_PROFILE:-dsh-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "error: profile not found: $PROFILE_DIR" >&2
  echo "hint: list them with: ls \"$DSH_HOME/profiles\"" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR/plugins"
rm -rf "$PROFILE_DIR/plugins/turn-keepalive"
cp -R "$HERE/plugin" "$PROFILE_DIR/plugins/turn-keepalive"
echo "installed plugin: $PROFILE_DIR/plugins/turn-keepalive"

if [ -f "$PATCH" ] && grep -q "id: turn-keepalive" "$PATCH"; then
  echo "patch already references turn-keepalive: $PATCH (left untouched)"
else
  cat >>"$PATCH" <<'YAML'

# Refuse to close a turn while this session still owns a running job, so the
# agent cannot go idle waiting for a settlement that may never arrive.
- insert:
    - id: turn-keepalive
      name: ./plugins/turn-keepalive/index.js
      config:
        minSteerIntervalMs: 120000
        # kinds: ['bash']   # optional: guard only these job kinds
YAML
  echo "appended loader row: $PATCH"
fi

if command -v dsh >/dev/null 2>&1; then
  if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "turn-keepalive"; then
    echo "composition check: turn-keepalive is in the composed tree"
  else
    echo "warning: turn-keepalive did not appear in --dump-config output" >&2
    echo "         check the YAML indentation in $PATCH" >&2
    exit 1
  fi
fi

echo
echo "Restart dsh --profile $PROFILE to activate."
echo "Smoke test: start a long background job, then end the turn."
echo "Expected: the turn is pulled back with '回合不能结束 ...'."
echo "Disable: delete the turn-keepalive insert block from $PATCH and restart."

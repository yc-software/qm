#!/bin/sh
set -eu
VENV=/opt/browser-engine/venv
if "$VENV/bin/python" -c 'import browser_use, playwright' 2>/tmp/browse-runtime-probe.txt; then
  exit 0
fi
[ -x "$VENV/bin/python" ] && { echo "existing runtime is broken, reinstalling:" >&2; cat /tmp/browse-runtime-probe.txt >&2; }
SUDO=""
[ "$(id -u)" = 0 ] || SUDO=sudo
$SUDO mkdir -p /opt/browser-engine
$SUDO chown "$(id -u)" /opt/browser-engine
python3 -m venv "$VENV"
"$VENV/bin/pip" install --no-cache-dir -q "browser-use==0.12.9" "playwright==1.64.0"
"$VENV/bin/python" -c 'import browser_use, playwright; print("browse runtime ok")'

#!/usr/bin/env bash
set -euo pipefail
MSG="$1"
B=~/.claude/skills/gstack/browse/dist/browse
SEL='.ql-editor[aria-label^="Message to "]'

"$B" js 'const c=document.querySelector("[data-qa=close_flexpane],button[aria-label^=Close]"); if(c)c.click(); true' >/dev/null 2>&1 || true
sleep 0.6
"$B" click "$SEL" >/dev/null
"$B" press "Escape" >/dev/null
"$B" click "$SEL" >/dev/null
for _ in 1 2 3; do
  "$B" press "Control+A" >/dev/null
  "$B" press "Delete" >/dev/null
  EMPTY=$("$B" js 'document.querySelector(".ql-editor[aria-label^=\"Message to \"]").textContent.trim().length===0' 2>/dev/null | tr -d '[:space:]')
  [ "$EMPTY" = "true" ] && break
done

"$B" type "@agent" >/dev/null
sleep 1.2
"$B" press "Enter" >/dev/null
sleep 0.8

HAS=$("$B" js 'const e=document.querySelector(".ql-editor[aria-label^=\"Message to \"]"); !!e.querySelector("ts-mention")' 2>/dev/null | tr -d '[:space:]')
if [ "$HAS" != "true" ]; then echo "ERROR: mention chip did not form"; exit 1; fi

"$B" type "$MSG" >/dev/null
sleep 0.6
TXT=$("$B" js 'document.querySelector(".ql-editor[aria-label^=\"Message to \"]").textContent' 2>/dev/null)
echo "composer: $TXT"
"$B" press "Enter" >/dev/null
echo "sent."

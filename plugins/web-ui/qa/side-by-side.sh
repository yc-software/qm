#!/usr/bin/env bash
set -euo pipefail
if (($# < 3)); then
  echo "usage: side-by-side.sh before.mp4 after.mp4 out.mp4 [before-label] [after-label]" >&2
  exit 2
fi
before=$1 after=$2 out=$3 left=${4:-Before} right=${5:-After}
duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
longest=$(printf '%s\n%s\n' "$(duration "$before")" "$(duration "$after")" | sort -g | tail -1)
font=$(fc-match -f '%{file}' 'DejaVu Sans:bold' 2>/dev/null || true)
label() { echo "drawtext=${font:+fontfile=$font:}text='$1':x=12:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6"; }
pane() { echo "scale=-2:720,tpad=stop_mode=clone:stop_duration=$longest,$(label "$1")"; }
ffmpeg -y -loglevel error -i "$before" -i "$after" -filter_complex \
  "[0:v]$(pane "$left")[l];[1:v]$(pane "$right")[r];[l][r]hstack=inputs=2,trim=duration=$longest[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -crf 28 -preset veryfast -movflags +faststart "$out"
echo "$out"

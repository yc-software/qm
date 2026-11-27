#!/bin/zsh
# Renders before/after screenshots for the AI consent PR on an iPad Air simulator.
set -u
R=https://raw.githubusercontent.com/yc-software/qm/eve/ios-ai-data-consent-screenshots/harness
B=~/qm-ios-build
rm -rf /tmp/qm-consent-shots; mkdir -p /tmp/qm-consent-shots
git -C $B fetch -q origin main eve/ios-ai-data-consent || exit 1
DEST=$(xcrun simctl list devices available | grep -m1 -o 'iPad Air[^(]*' | sed 's/ *$//')
echo "DEST=$DEST"
for side in before after; do
  W=/tmp/qm-consent-$side
  git -C $B worktree remove --force $W 2>/dev/null; rm -rf $W
  ref=origin/main; [ $side = after ] && ref=origin/eve/ios-ai-data-consent
  git -C $B worktree add -q --detach $W $ref || exit 1
  cd $W/ios
  curl -fsSL $R/ShotSupport.swift -o QMTests/ShotSupport.swift
  only=(-only-testing:QMTests/SettingsShots)
  if [ $side = after ]; then curl -fsSL $R/ConsentShots.swift -o QMTests/ConsentShots.swift; only+=(-only-testing:QMTests/ConsentShots); fi
  xcodegen generate -q >/dev/null 2>&1 || xcodegen generate
  TEST_RUNNER_SHOT_PREFIX=$side xcodebuild test -project QM.xcodeproj -scheme QM \
    -destination "platform=iOS Simulator,name=$DEST" "${only[@]}" -quiet 2>&1 | tail -15
  echo "$side EXIT=$?"
done
ls -la /tmp/qm-consent-shots

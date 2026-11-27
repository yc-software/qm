#!/bin/zsh
# Renders before/after screenshots for the AI consent PR on an iPad Air simulator, then pushes them.
set -u
R=https://raw.githubusercontent.com/yc-software/qm/eve/ios-ai-data-consent-screenshots/harness
B=~/qm-ios-build
rm -rf /tmp/qm-consent-shots; mkdir -p /tmp/qm-consent-shots
git -C $B fetch -q origin +main:refs/qmshots/before +eve/ios-ai-data-consent:refs/qmshots/after || exit 1
UDID=$(xcrun simctl list devices available | grep 'iPad Air' | grep -m1 -oE '[0-9A-F-]{36}')
xcrun simctl list devices available | grep 'iPad Air'
echo "UDID=$UDID"
for side in before after; do
  W=/tmp/qm-consent-$side
  git -C $B worktree remove --force $W 2>/dev/null; rm -rf $W
  git -C $B worktree add -q --detach $W refs/qmshots/$side || exit 1
  cd $W/ios
  curl -fsSL $R/ShotSupport.swift -o QMTests/ShotSupport.swift
  only=(-only-testing:QMTests/SettingsShots)
  if [ $side = after ]; then curl -fsSL $R/ConsentShots.swift -o QMTests/ConsentShots.swift; only+=(-only-testing:QMTests/ConsentShots); fi
  xcodegen generate >/dev/null
  TEST_RUNNER_SHOT_PREFIX=$side xcodebuild test -project QM.xcodeproj -scheme QM \
    -destination "id=$UDID" -derivedDataPath /tmp/qm-consent-dd "${only[@]}" > /tmp/qm-consent-$side.log 2>&1
  echo "$side EXIT=$?"
  grep -E "error:|Executed|TEST (SUCCEEDED|FAILED)|failed" /tmp/qm-consent-$side.log | tail -15
done
ls -la /tmp/qm-consent-shots
cd /tmp && rm -rf qm-shots-push && git clone -q --depth 1 -b eve/ios-ai-data-consent-screenshots https://github.com/yc-software/qm.git qm-shots-push && cd qm-shots-push
mkdir -p shots && cp /tmp/qm-consent-shots/*.png shots/ 2>/dev/null
tail -60 /tmp/qm-consent-before.log > shots/before.log; tail -80 /tmp/qm-consent-after.log > shots/after.log
git add -A && git -c user.name='Eve Bouffard' -c user.email='103564765+evebouf@users.noreply.github.com' commit -qm 'Screenshots' && git push -q origin HEAD && echo SHOTS_PUSHED

Fresh fly deploys crash-loop with no warning: the CLI's secret check never
sees the sprites backend value the runtime derives, so it never asks for
SPRITES_TOKEN.

Update after PR feedback: cdolan-personal hit the same crash on the
docker target — setting the typed sandbox.backend: "sprites" field doesn't
register the requirement either, since the check only reads the raw env
var. So instead of just adding the missing entry to the fly defaults
table like the AWS one has, the fix I'd propose is keying the
SPRITES_TOKEN requirement off the resolved backend, so every target is
covered. Still worth checking if other secrets have the same blind spot.

Context: https://github.com/yc-software/qm/issues/130 and the comments on
this PR.

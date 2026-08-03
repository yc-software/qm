Fresh fly deploys crash-loop with no warning: the CLI's secret check never
sees the sprites backend value the runtime derives, so it never asks for
SPRITES_TOKEN. I'd add the missing entry to the fly defaults table like the
AWS one has, and maybe check if other secrets have the same blind spot.

Context: https://github.com/yc-software/qm/issues/130

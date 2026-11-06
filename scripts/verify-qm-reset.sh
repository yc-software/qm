#!/usr/bin/env bash
set -euo pipefail
config=${1:-deploy/stacks/sharechat/qm.config.jsonc}
node -e 'const fs=require("fs"); const s=fs.readFileSync(process.argv[1],"utf8"); if (!/"HARNESS"\s*:\s*"pi"/.test(s)) throw new Error("HARNESS is not pi"); if (/ultimate/i.test(s)) throw new Error("Ultimate reference remains in deployment config"); for (const p of ["work/qm-finance-skill-pack","work/sharechat-skills"]) if (!fs.existsSync(p)) throw new Error(`Missing ${p}`); console.log("QM reset verification passed")' "$config"

#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm run build
out="${1:?Usage: demo/build.sh /absolute/output/directory}"
mkdir -p "$out"
cp -R dist-web/. "$out/"
cp demo/mock.js demo/server.mjs "$out/"
node - "$out/index.html" <<'JS'
const fs = require('node:fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<div id="app"></div>', '<div id="app"></div><script src="/mock.js"></script>'));
JS

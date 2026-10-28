#!/usr/bin/env bash
set -euo pipefail
crm_project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$crm_project_root/vendor/twenty"
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  printf '%s\n' 'Twenty requires Node.js 24 (archive declares ^24.5).' >&2
  exit 1
fi
export NX_DAEMON=false NX_NO_CLOUD=true YARN_ENABLE_TELEMETRY=0
node .yarn/releases/yarn-4.13.0.cjs install --immutable
# Direct build avoids Nx daemon/barrel generation assumptions. Dependency scripts
# are the locked upstream packages; this does not read any old .env file.
for crm_package in twenty-shared twenty-client-sdk twenty-emails; do
  cd "$crm_project_root/vendor/twenty/packages/$crm_package"
  if [[ -f vite.config.ts ]]; then
    node ../../node_modules/vite/bin/vite.js build
  fi
  node ../../node_modules/@typescript/native-preview/bin/tsgo.js -p tsconfig.lib.json --declaration --emitDeclarationOnly --noEmit false --outDir dist --rootDir src || {
    printf '%s\n' "Type build needs upstream dependency reconciliation: $crm_package" >&2
    exit 1
  }
  node ../../node_modules/tsc-alias/dist/bin/index.js -p tsconfig.lib.json --outDir dist
done
cd "$crm_project_root/vendor/twenty/packages/twenty-ui"
node ../../node_modules/vite/bin/vite.js build
cd "$crm_project_root/vendor/twenty/packages/twenty-sdk"
for crm_vite_config in node define billing front-component logic-function browser; do
  node ../../node_modules/vite/bin/vite.js build -c "vite.config.$crm_vite_config.ts"
done
node ../../node_modules/@typescript/native-preview/bin/tsgo.js -p tsconfig.lib.json --declaration --emitDeclarationOnly --noEmit false --outDir dist --rootDir src
node ../../node_modules/tsc-alias/dist/bin/index.js -p tsconfig.lib.json --outDir dist
node ../../node_modules/rollup/dist/bin/rollup -c rollup.config.sdk-dts.mjs
cd "$crm_project_root/vendor/twenty/packages/twenty-server"
node ../../node_modules/@nestjs/cli/bin/nest.js build --path tsconfig.build.json
mkdir -p dist/assets/twenty-client-sdk
cp -a ../twenty-client-sdk/package.json ../twenty-client-sdk/dist dist/assets/twenty-client-sdk/

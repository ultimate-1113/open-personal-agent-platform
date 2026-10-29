#!/usr/bin/env sh
set -eu

profile="cloud-base"
apply="false"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      profile="${2:?--profile requires a value}"
      shift 2
      ;;
    --apply)
      apply="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$profile" in
  local-dev|minimal|cloud-base|cloud-base-dynamic) ;;
  *) echo "Unknown profile: $profile" >&2; exit 2 ;;
esac

node_version="$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)$/\1 \2 \3/p')"
if [ -z "$node_version" ]; then
  echo "Node.js 26 LTS (26.13.0 or newer, below 27) is required." >&2
  exit 1
fi
set -- $node_version
node_major="$1"
node_minor="$2"
if [ "$node_major" -ne 26 ] || [ "$node_minor" -lt 13 ]; then
  echo "Node.js 26 LTS (26.13.0 or newer, below 27) is required." >&2
  exit 1
fi

echo "Installing OPAP dependencies with pnpm 11.23.0..."
npx --yes pnpm@11.23.0 install --frozen-lockfile --config.confirmModulesPurge=false

if [ "$apply" = "true" ]; then
  npx --yes pnpm@11.23.0 opap setup --profile "$profile" --apply
else
  npx --yes pnpm@11.23.0 opap setup --profile "$profile"
fi

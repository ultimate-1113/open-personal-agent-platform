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

node_major="$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
if [ -z "$node_major" ] || [ "$node_major" -lt 24 ]; then
  echo "Node.js 24 LTS or newer is required." >&2
  exit 1
fi

echo "Installing OPAP dependencies with pnpm 11.23.0..."
corepack pnpm@11.23.0 install --frozen-lockfile --config.confirmModulesPurge=false

if [ "$apply" = "true" ]; then
  corepack pnpm@11.23.0 opap setup --profile "$profile" --apply
else
  corepack pnpm@11.23.0 opap setup --profile "$profile"
fi

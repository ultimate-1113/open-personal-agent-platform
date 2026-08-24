#!/usr/bin/env sh
set -eu
directory="${1:-.}"
cd "$directory"
sha256sum --check SHA256SUMS

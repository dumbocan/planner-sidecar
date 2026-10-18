#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_BASE_URL="https://github.com/Gentleman-Programming/gentle-ai/releases/download/v4.2.0"
readonly ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifacts"

case "$(uname -m)" in
  x86_64|amd64)
    archive="gentle-ai_4.2.0_linux_amd64.tar.gz"
    checksum="552c1642fd10f5d96cfe9bb1cc3b66b30eb47d3074cc7ca0559b598eb086defc"
    ;;
  aarch64|arm64)
    archive="gentle-ai_4.2.0_linux_arm64.tar.gz"
    checksum="2bebe91b8808ce48d86c4d3700d098e37cb6b0658f196c666d9deeeb7c7c1a7a"
    ;;
  *)
    printf 'unsupported native architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$ARTIFACT_DIR"
artifact="$ARTIFACT_DIR/$archive"

if [[ -f "$artifact" ]] && echo "$checksum  $artifact" | sha256sum --check --status; then
  exit 0
fi

rm -f "$artifact"
temporary_artifact="$(mktemp "$ARTIFACT_DIR/.${archive}.XXXXXX")"
trap 'rm -f "$temporary_artifact"' EXIT

curl --fail --location --retry 3 --output "$temporary_artifact" "$RELEASE_BASE_URL/$archive"
echo "$checksum  $temporary_artifact" | sha256sum --check
mv "$temporary_artifact" "$artifact"
trap - EXIT

echo "$checksum  $artifact" | sha256sum --check

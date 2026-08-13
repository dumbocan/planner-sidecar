#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_BASE_URL="https://github.com/Gentleman-Programming/gentle-ai/releases/download/v2.3.0"
readonly ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifacts"

case "$(uname -m)" in
  x86_64|amd64)
    archive="gentle-ai_2.3.0_linux_amd64.tar.gz"
    checksum="899d3382c39c4095d7830def523e27a78aa94c410e63e36a7aa702a186f43f99"
    ;;
  aarch64|arm64)
    archive="gentle-ai_2.3.0_linux_arm64.tar.gz"
    checksum="d3385c41094b7a53cc4d96132b86822bcacd0cd06bb5b58ab2a592c45bb827d8"
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

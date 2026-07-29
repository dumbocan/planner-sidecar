#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_BASE_URL="https://github.com/Gentleman-Programming/gentle-ai/releases/download/v2.1.11"
readonly ARTIFACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifacts"

case "$(uname -m)" in
  x86_64|amd64)
    archive="gentle-ai_2.1.11_linux_amd64.tar.gz"
    checksum="d115aaf5724a71503150ebf740769e7aa52e41e673ac39bf5b0ff1be4e3324b0"
    ;;
  aarch64|arm64)
    archive="gentle-ai_2.1.11_linux_arm64.tar.gz"
    checksum="aea3a4b0064b57df5f831fdf6b27b29e9898a8f9393fd648dea4a8ba563e477e"
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

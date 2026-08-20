#!/usr/bin/env bash
#
# Publish the draft and report what shipped. Point of no return: the release is
# immutable from here, so every matrix job must already have uploaded.

set -euo pipefail

# --target pins the tag to the commit that was built; the draft points at main,
# which may have moved during the matrix.
gh release edit "${TAG}" --target "${SHA}" --draft=false

gh release view "${TAG}" --json assets --jq '.assets[] | "  \(.name)  \(.size) bytes"'
COUNT="$(gh release view "${TAG}" --json assets --jq '.assets | length')"

if [ "${COUNT}" -eq 0 ]; then
    echo "::error::${TAG} published with no assets and cannot be repaired. Cut the next version rather than retrying this one."
    exit 1
fi

echo "${TAG} published with ${COUNT} assets."

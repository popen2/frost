#!/usr/bin/env bash
#
# Read the tag off release-drafter's draft and hand it to the workflow. The
# draft is the source of truth for the version - release-drafter resolves it
# from PR labels - so nothing here invents a number.

set -euo pipefail

WANTED="${WANTED:-}"

# There is no `gh` command for "the newest draft", so use the API for the list.
# Newest first is the endpoint's own order.
if [ -n "${WANTED}" ]; then
    TAG="$(gh api 'repos/{owner}/{repo}/releases' \
        --jq "map(select(.draft and .tag_name == \"${WANTED}\")) | first | .tag_name // empty")"
else
    TAG="$(gh api 'repos/{owner}/{repo}/releases' \
        --jq 'map(select(.draft)) | first | .tag_name // empty')"
fi

if [ -z "${TAG}" ]; then
    echo "::error::No draft release found${WANTED:+ for ${WANTED}}. Needs a push to main to create one, and contents: write to see it."
    exit 1
fi

# The build stamps the version into package.json and reconstructs the tag as
# v<version> to upload, so it has to round-trip.
case "${TAG}" in
    v*) VERSION="${TAG#v}" ;;
    *)
        echo "::error::Draft tag '${TAG}' does not start with 'v', so the upload would look for a release that does not exist."
        exit 1
        ;;
esac

echo "Releasing ${TAG} (version ${VERSION})"

{
    echo "tag=${TAG}"
    echo "version=${VERSION}"
} >> "$GITHUB_OUTPUT"

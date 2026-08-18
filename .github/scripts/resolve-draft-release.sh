#!/usr/bin/env bash
#
# Read the tag off release-drafter's draft and hand it to the workflow. The
# draft is the source of truth for the version - release-drafter resolves it
# from PR labels - so nothing here invents a number.

set -euo pipefail

WANTED="${WANTED:-}"

# There is no `gh` command for "the newest draft", so use the API for the list.
# Newest first is the endpoint's own order. It only includes drafts when the
# token has push access - a read-only one just returns published releases, and
# looks exactly like there being no draft.
if [ -n "${WANTED}" ]; then
    TAG="$(gh api 'repos/{owner}/{repo}/releases' \
        --jq "map(select(.draft and .tag_name == \"${WANTED}\")) | first | .tag_name // empty")"
else
    TAG="$(gh api 'repos/{owner}/{repo}/releases' \
        --jq 'map(select(.draft)) | first | .tag_name // empty')"
fi

if [ -z "${TAG}" ]; then
    echo "::error::No draft release found${WANTED:+ for ${WANTED}}. release-drafter creates one on each push to main - and check the job has contents: write, since a read-only token cannot see drafts at all."
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

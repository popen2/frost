#!/usr/bin/env bash
#
# Attach one matrix job's distributables to the draft release. It has to still
# be a draft - a published release is immutable and rejects uploads - so
# release.yaml publishes only once every job has run this.

set -euo pipefail

# -print0 rather than a glob: the artifact names are ours, but the runner's
# checkout path is not.
assets=()
while IFS= read -r -d '' asset; do
    assets+=("${asset}")
done < <(find out/make -type f -print0)

if [ ${#assets[@]} -eq 0 ]; then
    echo "::error::No distributables found under out/make"
    exit 1
fi

printf 'Uploading to draft %s:\n' "${TAG}"
printf '  %s\n' "${assets[@]}"

# --clobber so re-running a failed job is idempotent.
gh release upload "${TAG}" "${assets[@]}" --clobber

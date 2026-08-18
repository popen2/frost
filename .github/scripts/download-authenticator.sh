#!/usr/bin/env bash
#
# Fetch the aws-iam-authenticator for one matrix row and check it against the
# checksum pinned beside that row in build.yaml. Release assets are mutable and
# this binary ends up in a signed app and in every user's kubeconfig as the
# `exec` plugin, so the tag alone is not a strong enough pin.

set -euo pipefail

URL="https://github.com/kubernetes-sigs/aws-iam-authenticator/releases/download/v${AWS_IAM_AUTHENTICATOR_VERSION}/aws-iam-authenticator_${AWS_IAM_AUTHENTICATOR_VERSION}_${OS_AWS}_${ARCH_AWS}${EXE}"
TARGET="aws-iam-authenticator${EXE}"

# -f so a missing asset fails here instead of packaging GitHub's 404 page as
# the binary.
curl -fL "${URL}" -o "${TARGET}"

# Node rather than sha256sum or shasum: those are spelled differently across the
# three runners, and setup-node has already guaranteed this one is here.
ACTUAL="$(node -e 'const {createHash}=require("crypto"),{readFileSync}=require("fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "${TARGET}")"

if [ "${ACTUAL}" != "${EXPECTED}" ]; then
    echo "::error::aws-iam-authenticator ${AWS_IAM_AUTHENTICATOR_VERSION} ${OS_AWS}_${ARCH_AWS} does not match its pinned checksum"
    echo "  expected ${EXPECTED}"
    echo "  actual   ${ACTUAL}"
    echo "  from     ${URL}"
    exit 1
fi

echo "aws-iam-authenticator checksum verified: ${ACTUAL}"

chmod a+x "${TARGET}"

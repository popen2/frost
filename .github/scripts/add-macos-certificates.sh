#!/usr/bin/env bash
#
# Import the Developer ID into a keychain and drop the notarytool key where
# forge.config.js looks for it (APPLE_API_KEY is the key ID, which names the
# file). Secrets arrive through the environment so they are never substituted
# into this script's text - keep it that way if you add another.

set -euo pipefail

KEY_CHAIN=build.keychain
MACOS_CERT_P12_FILE=certificate.p12

echo "$MAC_CERTS" | base64 --decode > "$MACOS_CERT_P12_FILE"
security create-keychain -p actions "$KEY_CHAIN"
security default-keychain -s "$KEY_CHAIN"
security unlock-keychain -p actions "$KEY_CHAIN"
security import "$MACOS_CERT_P12_FILE" -k "$KEY_CHAIN" -P "$MAC_CERTS_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k actions "$KEY_CHAIN"
rm -rf ./*.p12

mkdir -p ~/private_keys
echo "$APPLE_API_AUTHKEY_BASE64" | base64 -d > ~/private_keys/"AuthKey_${APPLE_API_KEY}.p8"

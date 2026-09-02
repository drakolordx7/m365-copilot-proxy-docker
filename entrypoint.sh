#!/bin/sh
set -e

if [ -n "$M365_MSAL_CACHE_JSON" ]; then
  mkdir -p /root/.config/opencode-m365
  echo "$M365_MSAL_CACHE_JSON" > /root/.config/opencode-m365/msal-cache.json
  echo "Injecting MSAL cache from environment variable."
fi

exec "$@"

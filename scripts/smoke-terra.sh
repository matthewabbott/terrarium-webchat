#!/usr/bin/env bash
set -euo pipefail

# Basic smoke tests for the Terra relay. Requires ACCESS_CODE and optionally SERVICE_TOKEN.
# Example:
#   ACCESS_CODE=terra-access SERVICE_TOKEN=super-secret-service-token BASE=https://mbabbott.com/terrarium scripts/smoke-terra.sh

BASE="${BASE:-https://mbabbott.com/terrarium}"
ACCESS_CODE="${ACCESS_CODE:-}"
SERVICE_TOKEN="${SERVICE_TOKEN:-}"

if [[ -z "$ACCESS_CODE" ]]; then
  echo "ACCESS_CODE is required" >&2
  exit 1
fi

echo "Hitting health..."
curl -fsSL "$BASE/api/health?accessCode=$ACCESS_CODE"
echo -e "\n---"

if [[ -n "$SERVICE_TOKEN" ]]; then
  echo "Checking open chats..."
  curl -fsSL -H "x-service-token: $SERVICE_TOKEN" "$BASE/api/chats/open"
  echo -e "\n---"
  echo "Metrics snapshot..."
  curl -fsSL -H "x-service-token: $SERVICE_TOKEN" "$BASE/api/metrics"
  echo -e "\n---"
else
  echo "SERVICE_TOKEN not set; skipping authenticated checks."
fi

echo "Smoke tests done."

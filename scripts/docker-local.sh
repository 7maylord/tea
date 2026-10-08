#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ ! -f "$ROOT/backend/.env" ]; then
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  echo "Created backend/.env. Fill Privy, email, identity and signer values before testing authenticated flows."
fi

if [ ! -f "$ROOT/frontend/.env" ]; then
  cp "$ROOT/frontend/.env.example" "$ROOT/frontend/.env"
  echo "Created frontend/.env. Fill NEXT_PUBLIC_PRIVY_APP_ID before testing sign-in."
fi

set -a
. "$ROOT/frontend/.env"
set +a

exec docker compose --env-file "$ROOT/frontend/.env" -f "$ROOT/infrastructure/compose.app.yaml" "$@"

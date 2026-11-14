#!/bin/sh
# The servers test/live.test.ts reads from, as throwaway containers on loopback ports: HashiCorp
# Vault and OpenBao in dev mode, a new Infisical, and an AWS emulator (moto). Prints the settings
# the test goes by. CI's `sources` job runs this; by hand (docker and the aws CLI are needed):
#   export $(sh test/live-servers.sh) && node --test test/live.test.ts
#   sh test/live-servers.sh down
# Infisical is set up once by the test, so start again for a second run. Every value is made up.
set -eu
docker rm -f ks-live-vault ks-live-bao ks-live-moto ks-live-infisical ks-live-pg ks-live-redis >/dev/null 2>&1 || true
docker network rm ks-live >/dev/null 2>&1 || true
[ "${1:-}" = down ] && exit 0

docker network create ks-live >/dev/null
docker run -d --name ks-live-vault -p 127.0.0.1:18200:8200 --cap-add IPC_LOCK -e VAULT_DEV_ROOT_TOKEN_ID=live-root -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 hashicorp/vault:2.2.2 >/dev/null
docker run -d --name ks-live-bao -p 127.0.0.1:18201:8200 -e BAO_DEV_ROOT_TOKEN_ID=live-root -e BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200 openbao/openbao:2.7.2 server -dev -dev-no-store-token >/dev/null
docker run -d --name ks-live-moto -p 127.0.0.1:18300:5000 motoserver/moto:5.2.5 >/dev/null
docker run -d --name ks-live-pg --network ks-live -e POSTGRES_USER=infisical -e POSTGRES_PASSWORD=made-up -e POSTGRES_DB=infisical postgres:14-alpine >/dev/null
docker run -d --name ks-live-redis --network ks-live redis:7.4-alpine >/dev/null
docker run -d --name ks-live-infisical --network ks-live -p 127.0.0.1:18280:8080 -e NODE_ENV=production -e TELEMETRY_ENABLED=false -e HTTPS_ENABLED=false \
  -e SITE_URL=http://127.0.0.1:18280 -e ENCRYPTION_KEY="$(openssl rand -hex 16)" -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e DB_CONNECTION_URI=postgres://infisical:made-up@ks-live-pg:5432/infisical -e REDIS_URL=redis://ks-live-redis:6379 infisical/infisical:v0.167.10 >/dev/null

# Infisical migrates its database before it answers.
for url in http://127.0.0.1:18200/v1/sys/health http://127.0.0.1:18201/v1/sys/health http://127.0.0.1:18300/moto-api/ http://127.0.0.1:18280/api/status; do
  tries=0
  until curl -fsS -o /dev/null --max-time 5 "$url"; do
    tries=$((tries + 1))
    [ "$tries" -lt 90 ] || { echo "$url did not come up" >&2; exit 1; }
    sleep 2
  done 2>/dev/null
done

echo KEYSHROUD_LIVE_VAULT=http://127.0.0.1:18200,http://127.0.0.1:18201
echo KEYSHROUD_LIVE_VAULT_TOKEN=live-root
echo KEYSHROUD_LIVE_INFISICAL=http://127.0.0.1:18280
echo KEYSHROUD_LIVE_AWS=http://127.0.0.1:18300

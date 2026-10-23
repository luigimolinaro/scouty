#!/usr/bin/env bash
# Prepara e avvia Scouty: .env, cartella data/ con i permessi giusti, primo utente, docker compose.
# Si può rilanciare senza rischi: non sovrascrive .env, utenti o dati esistenti.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env}"
export ENV_FILE
HTTPS=0
START=1

die() { echo "Errore: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

usage() {
  cat <<EOF
Uso: $0 [--https] [--no-start]

  --https       chiede il dominio, imposta DOMAIN, COOKIE_SECURE=1 e TRUST_PROXY=1 e avvia anche Caddy
  --no-start    prepara .env, data/ e il primo utente senza avviare Docker

Cosa fa, in ordine:
  1. crea .env da .env.example (senza gli utenti di esempio) se manca
  2. crea data/ e la intesta all'utente del container (DATA_UID:DATA_GID, default 1000:1000)
  3. se non ci sono utenti chiede nome e password del primo coach
  4. docker compose up -d --build e attende che l'app risponda
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --https) HTTPS=1 ;;
    --no-start) START=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
  shift
done

get_env() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)
  v="${v#*=}"; v="${v#\'}"; v="${v%\'}"; v="${v#\"}"; v="${v%\"}"
  printf '%s' "$v"
}

set_env() {   # set_env CHIAVE VALORE: sostituisce la riga o la aggiunge, tenendo una copia in .env.bak
  local key="$1" val="$2" tmp l found=0
  umask 077
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  cp -p "$ENV_FILE" "$ENV_FILE.bak"
  while IFS= read -r l || [ -n "$l" ]; do
    case "$l" in
      "$key="*) if [ "$found" -eq 0 ]; then printf '%s=%s\n' "$key" "$val"; found=1; fi ;;
      *) printf '%s\n' "$l" ;;
    esac
  done < "$ENV_FILE" > "$tmp"
  [ "$found" -eq 1 ] || printf '%s=%s\n' "$key" "$val" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# ---------- 0. requisiti ----------
if [ "$START" -eq 1 ]; then
  command -v docker >/dev/null 2>&1 || die "docker non trovato"
  docker compose version >/dev/null 2>&1 || die "manca il plugin 'docker compose'"
fi

# ---------- 1. .env ----------
if [ ! -f "$ENV_FILE" ]; then
  [ -f .env.example ] || die ".env.example mancante"
  ( umask 077; grep -v '^USERS=' .env.example > "$ENV_FILE" )
  chmod 600 "$ENV_FILE"
  say "Creato $ENV_FILE da .env.example"
elif get_env USERS | grep -q 'CambiaQuestaPassword'; then
  say "In $ENV_FILE ci sono gli utenti di esempio: li tolgo (copia in $ENV_FILE.bak)."
  set_env USERS "''"
fi

# ---------- 2. cartella data/ ----------
DATA_UID="$(get_env DATA_UID)"; DATA_UID="${DATA_UID:-1000}"
DATA_GID="$(get_env DATA_GID)"; DATA_GID="${DATA_GID:-1000}"
[[ "$DATA_UID" =~ ^[0-9]+$ && "$DATA_GID" =~ ^[0-9]+$ ]] || die "DATA_UID e DATA_GID devono essere numeri"

mkdir -p data
if [ "$(uname -s)" = "Linux" ]; then
  owner="$(stat -c '%u:%g' data)"
  if [ "$owner" != "$DATA_UID:$DATA_GID" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      chown -R "$DATA_UID:$DATA_GID" data
      say "data/ intestata a $DATA_UID:$DATA_GID (era $owner)"
    else
      die "data/ appartiene a $owner ma il container usa $DATA_UID:$DATA_GID e non potrebbe scriverci.
Esegui:  sudo chown -R $DATA_UID:$DATA_GID data
poi rilancia ./setup.sh"
    fi
  else
    say "data/ ok (proprietario $owner)"
  fi
else
  say "Nota: controllo dei permessi di data/ saltato (sistema non Linux)"
fi

# ---------- 3. primo utente ----------
if [ -z "$(get_env USERS)" ]; then
  [ -t 0 ] || die "nessun utente configurato: esegui  ./users.sh add <nome> coach  e rilancia ./setup.sh"
  say "Nessun utente configurato: creo il primo coach."
  read -rp "Nome utente: " NAME
  ./users.sh add "$NAME" coach
else
  say "Utenti già configurati (vedi ./users.sh list)"
fi

# ---------- 4. HTTPS ----------
if [ "$HTTPS" -eq 1 ]; then
  cur="$(get_env DOMAIN)"
  if [ -t 0 ]; then
    read -rp "Dominio [${cur}]: " dom
    dom="${dom:-$cur}"
  else
    dom="$cur"
  fi
  [[ "$dom" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$dom" == *.* ]] || die "dominio non valido: '$dom'"
  [ "$dom" != "scout.example.it" ] || die "imposta il tuo dominio (scout.example.it è solo un esempio)"
  set_env DOMAIN "$dom"
  set_env COOKIE_SECURE 1
  set_env TRUST_PROXY 1
  say "HTTPS: DOMAIN=$dom, COOKIE_SECURE=1, TRUST_PROXY=1"
fi

# ---------- 5. avvio ----------
if [ "$START" -eq 0 ]; then
  say "Preparazione completata. Avvia con:  docker compose up -d --build"
  exit 0
fi

PROFILE=()
[ "$HTTPS" -eq 1 ] && PROFILE=(--profile https)
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d --build

up() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- -T 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1
  else
    docker compose logs --tail 30 scout 2>&1 | grep -q 'in ascolto'
  fi
}

say "Attendo che l'app risponda..."
ok=0
for _ in $(seq 1 20); do
  if up; then ok=1; break; fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "L'app non risponde dopo 40 secondi. Ultime righe dei log:" >&2
  docker compose logs --tail 15 scout >&2 || true
  echo "Se vedi 'Cartella dati non scrivibile' controlla i permessi di data/ (README, sezione Dati e permessi)." >&2
  exit 1
fi

if [ "$HTTPS" -eq 1 ]; then url="https://$(get_env DOMAIN)"; else url="http://localhost:8080"; fi
say ""
say "Scouty è attivo: $url"
say "Log:      docker compose logs -f scout"
say "Utenti:   ./users.sh list"
say "Backup:   tar czf scouty-backup-\$(date +%F).tgz data"

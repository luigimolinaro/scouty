#!/usr/bin/env bash
# Gestione utenti di Scout pallavolo (variabile USERS del file .env)
set -e -o pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env}"
IMAGE="scout-pallavolo:latest"
ENTRIES=()

die() { echo "Errore: $*" >&2; exit 1; }

usage() {
  cat <<EOF
Uso: $0 <comando> [argomenti]

  list                     elenca gli utenti (le password non vengono mai mostrate)
  roles                    elenca i ruoli disponibili e gli utenti che li hanno
  add <nome> <ruolo>       aggiunge un utente (ruolo: coach | scoutman | scout)
  passwd <nome>            cambia la password
  role <nome> <ruolo>      cambia il ruolo
  remove <nome>            elimina un utente
  apply                    riavvia il servizio per applicare le modifiche

File di configurazione: $ENV_FILE (cambiabile con ENV_FILE=percorso)
Le password vengono chieste in modo nascosto e salvate cifrate (scrypt).
EOF
}

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

load() {
  ENTRIES=()
  [ -f "$ENV_FILE" ] || return 0
  local line v e parts
  line=$(grep -E '^USERS=' "$ENV_FILE" | tail -n1 || true)
  v="${line#USERS=}"
  v="${v#\'}"; v="${v%\'}"; v="${v#\"}"; v="${v%\"}"
  IFS=';' read -ra parts <<< "$v" || true
  for e in ${parts[@]+"${parts[@]}"}; do
    e="$(trim "$e")"
    [ -n "$e" ] && ENTRIES+=("$e")
  done
  return 0
}

save() {
  local val="" e line tmp found=0
  for e in ${ENTRIES[@]+"${ENTRIES[@]}"}; do val="${val:+$val;}$e"; done
  line="USERS='$val'"   # apici singoli: impediscono a compose di interpretare i "$" dell'hash
  umask 077
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  local src="$ENV_FILE"
  if [ -f "$ENV_FILE" ]; then
    cp -p "$ENV_FILE" "$ENV_FILE.bak"
  elif [ -f .env.example ]; then
    src=".env.example"   # primo uso: .env non esiste, si parte dall'esempio
    echo "Creo $ENV_FILE a partire da $src" >&2
  else
    src=""
  fi
  if [ -n "$src" ]; then
    while IFS= read -r l || [ -n "$l" ]; do
      case "$l" in
        USERS=*) if [ "$found" -eq 0 ]; then printf '%s\n' "$line"; found=1; fi ;;
        *) printf '%s\n' "$l" ;;
      esac
    done < "$src" > "$tmp"
  fi
  [ "$found" -eq 1 ] || printf '%s\n' "$line" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

e_name() { printf '%s' "${1%%:*}"; }
e_role() { printf '%s' "${1##*:}"; }
e_pw()   { local r="${1#*:}"; printf '%s' "${r%:*}"; }

# stampa l'indice dell'utente (nome senza distinzione maiuscole/minuscole), vuoto se non esiste
find_idx() {
  local want i=0 e
  want="$(lower "$1")"
  for e in ${ENTRIES[@]+"${ENTRIES[@]}"}; do
    [ "$(lower "$(e_name "$e")")" = "$want" ] && { echo "$i"; return 0; }
    i=$((i + 1))
  done
  return 0
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "nome non valido (ammessi: lettere, numeri, . _ -; max 40)"; }
valid_role() { case "$1" in coach|scoutman|scout) ;; *) die "ruolo non valido: usa coach, scoutman oppure scout" ;; esac; }

hash_pw() {
  local js="const c=require('crypto');let d='';process.stdin.on('data',x=>d+=x).on('end',()=>{const s=c.randomBytes(16);console.log('scrypt\$'+s.toString('hex')+'\$'+c.scryptSync(d,s,32).toString('hex'))})"
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$1" | node -e "$js"
  elif command -v docker >/dev/null 2>&1; then
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "Immagine $IMAGE non trovata: la costruisco (solo la prima volta)..." >&2
      docker build -q -t "$IMAGE" . >/dev/null || die "build dell'immagine fallita"
    fi
    printf '%s' "$1" | docker run --rm -i "$IMAGE" node -e "$js"
  else
    die "serve node oppure docker per cifrare la password"
  fi
}

ask_password() {
  local p1 p2
  read -rsp "Password: " p1; echo >&2
  read -rsp "Ripeti password: " p2; echo >&2
  [ "$p1" = "$p2" ] || die "le password non coincidono"
  [ "${#p1}" -ge 8 ] || die "password troppo corta (minimo 8 caratteri)"
  hash_pw "$p1"
}

cmd_list() {
  load
  [ "${#ENTRIES[@]}" -gt 0 ] || { echo "Nessun utente configurato: il server genera credenziali temporanee a ogni avvio."; return 0; }
  printf '%-20s %-8s %s\n' UTENTE RUOLO PASSWORD
  local e pw kind
  for e in "${ENTRIES[@]}"; do
    pw="$(e_pw "$e")"
    if [[ "$pw" =~ ^scrypt\$[0-9a-f]+\$[0-9a-f]+$ ]]; then kind="cifrata"; else kind="IN CHIARO (usa passwd per cifrarla)"; fi
    printf '%-20s %-8s %s\n' "$(e_name "$e")" "$(e_role "$e")" "$kind"
  done
}

cmd_roles() {
  load
  local r e names desc
  printf '%-8s %-30s %s\n' RUOLO UTENTI DESCRIZIONE
  for r in coach scoutman scout; do
    names=""
    for e in ${ENTRIES[@]+"${ENTRIES[@]}"}; do
      [ "$(e_role "$e")" = "$r" ] && names="${names:+$names, }$(e_name "$e")"
    done
    case "$r" in
      coach)    desc="scout, statistiche, squadra, storico, export" ;;
      scoutman) desc="come coach (per ora): scout, statistiche, squadra, storico, export" ;;
      scout)    desc="solo scout e squadra, niente statistiche" ;;
    esac
    printf '%-8s %-30s %s\n' "$r" "${names:--}" "$desc"
  done
}

cmd_add() {
  [ $# -eq 2 ] || die "uso: $0 add <nome> <ruolo>"
  valid_name "$1"; valid_role "$2"
  load
  [ -z "$(find_idx "$1")" ] || die "l'utente '$1' esiste già"
  ENTRIES+=("$1:$(ask_password):$2")
  save
  echo "Utente '$1' ($2) aggiunto. Esegui '$0 apply' per applicare."
}

cmd_passwd() {
  [ $# -eq 1 ] || die "uso: $0 passwd <nome>"
  load
  local i; i="$(find_idx "$1")"
  [ -n "$i" ] || die "utente '$1' non trovato"
  local name role; name="$(e_name "${ENTRIES[$i]}")"; role="$(e_role "${ENTRIES[$i]}")"
  ENTRIES[$i]="$name:$(ask_password):$role"
  save
  echo "Password di '$name' aggiornata. Le sue sessioni restano valide finché non cambi ruolo o lo elimini. Esegui '$0 apply'."
}

cmd_role() {
  [ $# -eq 2 ] || die "uso: $0 role <nome> <ruolo>"
  valid_role "$2"
  load
  local i; i="$(find_idx "$1")"
  [ -n "$i" ] || die "utente '$1' non trovato"
  ENTRIES[$i]="$(e_name "${ENTRIES[$i]}"):$(e_pw "${ENTRIES[$i]}"):$2"
  save
  echo "Ruolo di '$1' impostato a $2 (le sue sessioni attive decadono). Esegui '$0 apply'."
}

cmd_remove() {
  [ $# -eq 1 ] || die "uso: $0 remove <nome>"
  load
  local i; i="$(find_idx "$1")"
  [ -n "$i" ] || die "utente '$1' non trovato"
  [ "${#ENTRIES[@]}" -gt 1 ] || die "non puoi eliminare l'ultimo utente: il server creerebbe credenziali temporanee"
  local ans
  read -rp "Eliminare '$(e_name "${ENTRIES[$i]}")'? [s/N] " ans
  [[ "$ans" =~ ^[sSyY]$ ]] || { echo "Annullato."; return 0; }
  local new=() j=0 e
  for e in "${ENTRIES[@]}"; do [ "$j" -ne "$i" ] && new+=("$e"); j=$((j + 1)); done
  ENTRIES=("${new[@]}")
  save
  echo "Utente eliminato. Esegui '$0 apply' per applicare."
  if ! printf '%s\n' "${ENTRIES[@]}" | grep -qE ':(coach|scoutman)$'; then echo "Attenzione: non è rimasto nessun coach o scoutman."; fi
}

cmd_apply() {
  command -v docker >/dev/null 2>&1 || die "docker non trovato"
  docker compose up -d
}

[ $# -ge 1 ] || { usage; exit 1; }
cmd="$1"; shift
case "$cmd" in
  list)   cmd_list "$@" ;;
  roles)  cmd_roles "$@" ;;
  add)    cmd_add "$@" ;;
  passwd) cmd_passwd "$@" ;;
  role)   cmd_role "$@" ;;
  remove) cmd_remove "$@" ;;
  apply)  cmd_apply "$@" ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac

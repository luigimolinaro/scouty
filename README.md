# Scout pallavolo

Applicazione web per lo scout di partite di pallavolo, con login, ruoli e scout condiviso in tempo reale.

## Caratteristiche

- Server Node.js senza dipendenze esterne
- Interfaccia web in un unico file (`public/index.html`)
- Accesso con utente e password, con tre ruoli: `coach`, `scoutman` e `scout`
- Un solo utente alla volta può modificare la partita, gli altri vedono in diretta in sola lettura
- Statistiche, storico delle ultime partite ed esportazione in Excel e PDF
- Distribuzione con Docker, HTTPS opzionale tramite Caddy

## Struttura

| Percorso | Descrizione |
|---|---|
| `server.js` | Server HTTP e API |
| `public/` | Interfaccia web |
| `Dockerfile`, `docker-compose.yml` | Distribuzione con Docker |
| `Caddyfile` | Configurazione HTTPS (profilo `https`) |
| `users.sh` | Gestione degli utenti nel file `.env` |
| `scout-pallavolo/.env.example` | Esempio di configurazione |

## Avvio rapido

Crea il file `.env` partendo dall'esempio e imposta utenti e password:

```bash
cp scout-pallavolo/.env.example .env
```

Avvia con Docker:

```bash
docker compose up -d --build
```

L'app è raggiungibile su `http://localhost:8080`.

Per HTTPS con dominio proprio, imposta `DOMAIN`, `COOKIE_SECURE=1` e `TRUST_PROXY=1` nel `.env`, poi:

```bash
docker compose --profile https up -d --build
```

## Configurazione

Le impostazioni si definiscono con variabili d'ambiente nel file `.env`:

| Variabile | Descrizione |
|---|---|
| `USERS` | Utenti nel formato `nome:password:ruolo` separati da `;` |
| `COOKIE_SECURE` | `1` se si usa HTTPS |
| `TRUST_PROXY` | `1` se l'app è dietro un proxy |
| `DOMAIN` | Dominio per HTTPS automatico |
| `LOCK_TTL` | Secondi senza segnale dopo cui lo scout torna libero |
| `HISTORY_SIZE` | Numero di partite conservate nello storico |

Le password possono essere cifrate con `node server.js hash '<password>'`.

Il file `.env` contiene credenziali: non va mai committato.

## Ruoli

| Ruolo | Scout | Squadra | Statistiche, storico, export |
|---|---|---|---|
| `coach` | sì | sì | sì |
| `scoutman` | sì | sì | sì (per ora uguale a `coach`) |
| `scout` | sì | sì | no |

## Gestione utenti

Lo script `users.sh` modifica la variabile `USERS` del `.env` senza doverla scrivere a mano. Le password sono chieste in modo nascosto e salvate cifrate.

```bash
./users.sh list                 # elenca utenti e ruoli (senza password)
./users.sh roles                # elenca i ruoli disponibili e chi li ha
./users.sh add <nome> <ruolo>   # ruolo: coach | scoutman | scout
./users.sh passwd <nome>        # cambia la password
./users.sh role <nome> <ruolo>  # cambia il ruolo
./users.sh remove <nome>        # elimina un utente
./users.sh apply                # riavvia il servizio per applicare le modifiche
```

Se `.env` non esiste, `users.sh add` lo crea a partire da `scout-pallavolo/.env.example`: sul server basta quindi `./users.sh add <nome> coach` seguito da `docker compose up -d --build`. Prima di ogni modifica viene salvata una copia in `.env.bak`. Cambiare il ruolo o eliminare un utente invalida le sue sessioni attive. Per cifrare le password serve `node`; in alternativa usa Docker e, se manca, costruisce l'immagine alla prima esecuzione.

## Dati

I dati vengono salvati nel volume Docker `scout_data` (cartella `DATA_DIR`). Includono la partita in corso, lo storico e la chiave delle sessioni.

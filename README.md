# Scouty

Applicazione web per lo scout di partite di pallavolo, con login, ruoli e scout condiviso in tempo reale.

<img width="392" height="584" alt="image" src="https://github.com/user-attachments/assets/be51de68-0eb3-4641-9b4d-93cc333fb3e0" />

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

Serve Docker con il plugin compose.

```bash
git clone git@github.com:luigimolinaro/scouty.git && cd scouty
./users.sh add <nome> coach      # crea .env dall'esempio e aggiunge il primo utente
docker compose up -d --build
```

L'app è raggiungibile su `http://localhost:8080` (o `http://IP-DEL-SERVER:8080`).

Senza utenti configurati il server crea credenziali temporanee e le stampa nel log (`docker compose logs scout`).

### HTTPS con dominio

1. Punta un record DNS all'IP del server e apri le porte 80 e 443.
2. Nel `.env` imposta `DOMAIN`, `COOKIE_SECURE=1` e `TRUST_PROXY=1`.
3. Avvia con Caddy, che ottiene da solo il certificato Let's Encrypt:

```bash
docker compose --profile https up -d --build
```

4. Per non esporre la porta 8080 in chiaro, togli il blocco `ports` del servizio `scout` dal `docker-compose.yml`.

### Avvio senza Docker

```bash
USERS='mister:password:coach' DATA_DIR=./data node server.js
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

Le password possono essere scritte già cifrate (`node server.js hash '<password>'`), ma con `users.sh` è automatico.

Il file `.env` contiene credenziali ed è escluso da git: non va mai committato.

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

## Dati e backup

I dati stanno nel volume Docker `scout_data` (cartella `DATA_DIR`):

- `data.json`: partita in corso e squadre salvate
- `history.json`: le ultime partite concluse
- `secret`: chiave delle sessioni

Backup:

```bash
docker compose cp scout:/data ./backup
```

## Aggiornamento

```bash
git pull
docker compose up -d --build
```

I dati restano nel volume. La modifica di `.env` richiede solo `docker compose up -d`.

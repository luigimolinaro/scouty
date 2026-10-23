# Scout pallavolo

Applicazione web per lo scout di partite di pallavolo, con login, ruoli e scout condiviso in tempo reale.

## Caratteristiche

- Server Node.js senza dipendenze esterne
- Interfaccia web in un unico file (`public/index.html`)
- Accesso con utente e password, con ruoli `coach` e `scout`
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

## Dati

I dati vengono salvati nel volume Docker `scout_data` (cartella `DATA_DIR`). Includono la partita in corso, lo storico e la chiave delle sessioni.

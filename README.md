# Scouty

Applicazione web per lo scout di partite di pallavolo, con login, ruoli e scout condiviso in tempo reale.

<img width="313" height="313" alt="Scouty Owl Volleyball Logo" src="https://github.com/user-attachments/assets/23423f1f-89c4-4568-8eb0-7ab69cd0a1d7" />

## Caratteristiche

- Server Node.js senza dipendenze esterne
- Interfaccia web statica in tre file (`public/index.html`, `app.css`, `app.js`), senza build
- Aggiornamenti in tempo reale tra i telefoni (Server-Sent Events), con ripiego sul polling
- Se cade la rete le azioni restano sul telefono e partono al ritorno; se la pagina viene chiusa nel frattempo vengono recuperate alla riapertura (copia di sicurezza nel `localStorage`)
- Accesso con utente e password, con tre ruoli: `coach`, `scoutman` e `scout`
- Un solo utente alla volta può modificare la partita, gli altri vedono in diretta in sola lettura
- Più partite in corso insieme (una per squadra), con elenco nella scheda Scout; "Termina scout" lascia la partita agli altri
- Colore della squadra a scelta (giallo, turchese, blu, nero), salvato con la squadra
- Cambi con regole FIPAV: massimo 8 per set, ogni giocatrice rientra solo al posto della sua sostituta e una coppia può fare al più un cambio e un rientro per set
- Stats con grafici (efficienza, punti ed errori, positività, palleggio, andamento del punteggio con i cambi segnati da un cerchio, errori per tipo, ricezione per giocatrice) ingrandibili con un tocco
- Pulsante "Edita efficienze" nella modifica squadra (solo allenatore): obiettivi di efficienza (battuta, attacco, ricezione) e soglie di side-out e break point, impostati per ogni squadra, usati in Stats, tabellone e PDF
- **Campionati**: ogni squadra ha una lista di campionati configurabili (sezione "Campionati" nell'editor squadra). Quando si crea una nuova partita è obbligatorio scegliere il campionato dal menu a tendina. Per salvare una squadra già esistente è richiesto almeno un campionato
- Global stats (solo allenatore, nel menu Squadra sotto "Gestione squadra"): somma dello storico di una squadra; le partite si possono filtrare per campionato con le tab in cima; la lista delle partite mostra le ultime 3 per default, espandibile con un tocco; include tre classifiche — punti/errori (chi incide di più), efficienza per fondamentale (dove intervenire tatticamente) e trend per set (evoluzione della prestazione); l'export Excel include la colonna Presenze e il campionato di ogni partita; pulsante "ELIMINA STATS" (piccolo, in alto a destra, doppio tocco) per togliere tutte le partite della squadra dallo storico senza toccare la rosa salvata
- Stats di una partita in corso (sola lettura, con scelta tra le partite live) o dello storico: le ultime 10 partite sono a portata di tocco, tutte le altre nella sezione **Archivio partite** del menu Squadra (allenatore e scoutman, sotto Global stats), con filtro per squadra, scelta dell'anno, calendario mensile che segna i giorni in cui si è giocato e elenco del mese o del giorno. Le partite non vengono più cancellate da sole: si eliminano a mano
- "Riprendi scout" per riaprire una partita archiviata, possibile solo se non ci sono partite in corso
- Esportazione in Excel e PDF (due pagine A4 orizzontali: grafici piccoli, poi tabelle e tabellone)
- Distribuzione con Docker, HTTPS opzionale tramite Caddy

## Screenshot

<img width="993" height="1199" alt="image" src="https://github.com/user-attachments/assets/6a7895a0-b85c-4bf6-9eb9-d0537bbc1a95" />

## Struttura

| Percorso | Descrizione |
|---|---|
| `server.js` | Server HTTP e API |
| `public/` | Interfaccia web |
| `Dockerfile`, `docker-compose.yml` | Distribuzione con Docker |
| `Caddyfile` | Configurazione HTTPS (profilo `https`) |
| `setup.sh` | Prepara e avvia tutto: `.env`, cartella `data/`, primo utente, Docker |
| `users.sh` | Gestione degli utenti nel file `.env` |
| `data/` | Dati dell'app (creata da `setup.sh`, esclusa da git) |
| `.env.example` | Esempio di configurazione |
| `public/image/Scouty-Logo.jpg` | Logo opzionale (vedi sotto) |

## Avvio rapido

Serve Docker con il plugin compose.

```bash
git clone git@github.com:luigimolinaro/scouty.git && cd scouty
./setup.sh
```

`setup.sh` fa tutto in ordine e si può rilanciare senza rischi:

1. crea `.env` da `.env.example` se manca;
2. crea la cartella `data/` e controlla che appartenga all'utente del container (vedi [Dati e permessi](#dati-e-permessi));
3. se non ci sono utenti, chiede nome e password del primo coach;
4. avvia `docker compose up -d --build` e attende che l'app risponda.

Alla fine stampa l'indirizzo, di solito `http://localhost:8080` (o `http://IP-DEL-SERVER:8080`). Se l'app non parte mostra le ultime righe dei log.

Opzioni: `./setup.sh --no-start` prepara tutto senza avviare Docker, `./setup.sh --https` configura anche il dominio (vedi sotto).

Senza utenti configurati il server crea credenziali temporanee e le stampa nel log (`docker compose logs scout`).

### HTTPS con dominio

1. Punta un record DNS all'IP del server e apri le porte 80 e 443.
2. Esegui `./setup.sh --https`: chiede il dominio, imposta `DOMAIN`, `COOKIE_SECURE=1` e `TRUST_PROXY=1` nel `.env` e avvia anche Caddy, che ottiene da solo il certificato Let's Encrypt.
3. Per non esporre la porta 8080 in chiaro, togli il blocco `ports` del servizio `scout` dal `docker-compose.yml`.

Senza lo script: imposta a mano le tre variabili nel `.env` e lancia `docker compose --profile https up -d --build`.

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
| `MAX_LIVE` | Partite in corso contemporaneamente (default 5). Una sola per squadra: per giocarne due insieme servono due squadre diverse |
| `DATA_UID`, `DATA_GID` | Utente e gruppo con cui gira il container (default `1000`). `data/` deve appartenere a loro |

Le password possono essere scritte già cifrate (`node server.js hash '<password>'`), ma con `users.sh` è automatico.

Il file `.env` contiene credenziali ed è escluso da git: non va mai committato.

## Ruoli

| Ruolo | Scout | Squadra | Stats, storico, riprendi scout, export |
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

Se `.env` non esiste, `users.sh add` lo crea a partire da `.env.example`. Prima di ogni modifica viene salvata una copia in `.env.bak`. Cambiare il ruolo o eliminare un utente invalida le sue sessioni attive. Per cifrare le password serve `node`; in alternativa usa Docker e, se manca, costruisce l'immagine alla prima esecuzione.

## Dati e permessi

Tutti i dati stanno nella cartella `data/` accanto al progetto. Docker la monta nel container come `/data`. È esclusa da git e dalla build dell'immagine.

| File | Contenuto |
|---|---|
| `data/data.json` | Partite in corso (una per squadra) e squadre salvate. Un vecchio file con una sola partita viene convertito al primo avvio, e ne resta una copia in `data.json.v1` |
| `data/storico/AAAA/MM/<id>.json` | Una partita conclusa per file, in cartelle per anno e mese della data della partita. Nessun limite di numero. Se esiste un vecchio `history.json` (le ultime `HISTORY_SIZE` partite) viene importato al primo avvio e rinominato `history.json.v1`. Il backup è la cartella `data/` |
| `data/secret` | Chiave che firma le sessioni. Se la cancelli, tutti devono rifare il login |

I file vengono scritti dal server a ogni modifica, quindi `data/` non va modificata a mano mentre l'app gira. Per conservare le partite oltre il limite, esportale in Excel o PDF dalla scheda Stats.

### Permessi

Il container **non gira come root**: usa l'utente `1000:1000` (`DATA_UID` e `DATA_GID`). Il proprietario di `data/` deve essere lo stesso, altrimenti il server non può scrivere. Docker, se `data/` non esiste, la crea di proprietà di root e il problema compare al primo avvio.

`./setup.sh` se ne occupa:

- se `data/` ha già il proprietario giusto, non fa niente;
- se sei root, la intesta in automatico;
- se non sei root, si ferma e stampa il comando da eseguire con `sudo`.

A mano:

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

**Sintomo del problema:** `docker compose ps` mostra `Restarting` e `docker compose logs scout` ripete "Cartella dati non scrivibile". Si risolve con il `chown` qui sopra e `docker compose up -d`.

**Cartella di un altro utente.** Il container confronta i numeri, non i nomi: `chown www-data data` non basta, perché `www-data` è di solito `33`, non `1000`. Hai due strade:

1. dare la cartella all'utente del container: `sudo chown -R 1000:1000 data`;
2. far girare il container con l'utente della cartella. Controlla i numeri con `id www-data` e aggiungi nel `.env`:

   ```
   DATA_UID=33
   DATA_GID=33
   ```

   poi `docker compose up -d`.

### Backup e ripristino

Basta copiare la cartella, anche a servizio acceso:

```bash
tar czf scouty-backup-$(date +%F).tgz data
```

Ripristino: ferma l'app, sostituisci `data/` con il contenuto del backup, ripristina i permessi (`chown -R 1000:1000 data`) e riavvia.

```bash
docker compose stop
tar xzf scouty-backup-AAAA-MM-GG.tgz
sudo chown -R 1000:1000 data
docker compose up -d
```

## Aggiornamento

```bash
git pull
docker compose up -d --build
```

I dati restano in `data/`. La modifica di `.env` richiede solo `docker compose up -d`.

Se l'app va in `Restarting` dopo un aggiornamento, controlla i permessi di `data/` (vedi [Permessi](#permessi)).

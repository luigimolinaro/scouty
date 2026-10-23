# Scout pallavolo – versione online

App di scout per pallavolo con login, ruoli, scout condiviso in tempo reale e storico delle ultime 3 partite.
Server Node.js senza dipendenze esterne, pacchettizzato con Docker.

## Cosa fa

| Ruolo | Scout | Statistiche | Squadra | Storico | Export Excel/PDF |
|---|---|---|---|---|---|
| **Allenatore** (`coach`) | sì (in diretta o prendendo il controllo) | sì | sì | sì | sì |
| **Scout** (`scout`) | sì | no | sì | no | no |

**Uno scout alla volta.** Solo un utente alla volta può modificare la partita.

- Lo **scout** prende il controllo appena entra, se nessun altro lo ha già.
- Chi entra dopo vede la partita **in diretta** in sola lettura, con l'avviso *"luca (scout) sta facendo lo scout dalle 18:32"*.
- Con **Prendi il controllo** (due tocchi) si subentra, per esempio se il telefono dello scout si scarica. Chi perde il controllo viene avvisato.
- Se il telefono di chi fa scout non dà segnali per `LOCK_TTL` secondi (default 90), lo scout torna libero.
- L'allenatore prende il controllo solo quando modifica qualcosa e lo rilascia da solo dopo 2 minuti senza modifiche.

**Storico.** Una partita va nello storico quando finisce (3 set vinti) o quando si preme **Nuova partita**. Vengono tenute le ultime 3. L'allenatore le apre da *Statistiche → Partita:* e può esportarle.

## Installazione sul server Linux

Serve Docker con il plugin compose.

```bash
# 1. copia la cartella sul server, poi:
cd scout-pallavolo
cp .env.example .env
nano .env          # imposta utenti e password

# 2. avvio in http (prova su rete locale, porta 8080)
docker compose up -d --build
# apri http://IP-DEL-SERVER:8080
```

### HTTPS con dominio (consigliato)

1. Punta un record DNS (es. `scout.tuodominio.it`) all'IP del server e apri le porte 80 e 443.
2. Nel file `.env` imposta `DOMAIN=scout.tuodominio.it`, `COOKIE_SECURE=1` e `TRUST_PROXY=1`.
3. Avvia con Caddy, che ottiene il certificato Let's Encrypt da solo:

```bash
docker compose --profile https up -d --build
```

4. Per non esporre la porta 8080 in chiaro, togli il blocco `ports` del servizio `scout` dal `docker-compose.yml`.

## Utenti

Si configurano nella variabile `USERS` del file `.env`:

```
USERS=mister:PasswordForte1:coach;vice:PasswordForte2:coach;luca:PasswordForte3:scout
```

Se preferisci non tenere le password in chiaro, puoi scriverle già cifrate:

```bash
docker compose run --rm scout node server.js hash 'PasswordForte1'
# -> scrypt$....$....   (incollalo al posto della password)
```

Dopo aver modificato `.env`, riavvia con `docker compose up -d`. Se togli un utente o gli cambi ruolo, la sua sessione non vale più.

Senza `USERS` il server crea credenziali temporanee e le stampa nel log (`docker compose logs scout`).

## Dati e backup

I dati stanno nel volume `scout_data`:

- `data.json`: partita in corso e squadre salvate
- `history.json`: le ultime 3 partite
- `secret`: chiave delle sessioni

Backup:

```bash
docker run --rm -v scout-pallavolo_scout_data:/d -v "$PWD":/b alpine tar czf /b/scout-backup.tgz -C /d .
```

(il nome del volume dipende dalla cartella: controllalo con `docker volume ls`).

## Aggiornare l'app

Sostituisci `public/index.html` (e `server.js` se cambia), poi lancia `docker compose up -d --build`. I dati restano nel volume.

## Note

- Se la rete in palestra cade, lo scout continua a funzionare. La barra in alto diventa rossa e le modifiche vengono inviate appena torna la connessione, purché la pagina resti aperta.
- Il PDF si crea dalla stampa del browser con "Salva come PDF".
- Per avere l'icona sul telefono: apri il sito e scegli *Aggiungi a schermata Home*.

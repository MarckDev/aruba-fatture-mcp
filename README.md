# Aruba Fatture MCP

Server [MCP](https://modelcontextprotocol.io) per usare le API di **Aruba Fatturazione Elettronica** con Claude (Claude Code, Claude Desktop e qualsiasi client MCP).

Documentazione API di riferimento: <https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html>

## Tool disponibili

| Tool | Descrizione | Utenza richiesta |
|---|---|---|
| `get_user_info` | Informazioni account (P.IVA, stato servizio, spazio conservazione) | base |
| `get_invoice_notifications` | Notifiche SDI di una fattura per nome file (consegna, scarto, esiti) | base¹ |
| `send_invoice` | Invia una fattura XML a SDI — di default `dryRun=true` (solo validazione) | **Premium** |
| `search_invoices` | Ricerca fatture inviate o ricevute per periodo, stato, controparte | **Premium** |
| `get_invoice_detail` | Metadati completi di una fattura (per `id`, `filename` o `idSdi`) | **Premium** |
| `download_invoice` | Salva su disco XML, PDF, ZIP (fattura + notifiche) o PDD | **Premium** |

Le utenze **base** standalone non hanno le deleghe API (`FAW-*`): ricerca e dettaglio rispondono 401, l'upload risponde `0093 Errore deleghe` — ma solo **dopo** aver superato la validazione XSD, quindi un errore `0092` su upload non implica che l'invio sia abilitato. ¹L'endpoint notifiche risponde a livello dati con utenza base (verificato con `errorCode 0002`), ma non è stato possibile verificarlo con una fattura esistente.

## Requisiti

- Node.js ≥ 18
- Credenziali del servizio Aruba Fatturazione Elettronica

## Installazione

```bash
npm install
npm run build
```

## Configurazione

Il server legge tre variabili d'ambiente:

| Variabile | Descrizione |
|---|---|
| `ARUBA_USERNAME` | Username del servizio Fatturazione Elettronica |
| `ARUBA_PASSWORD` | Password del servizio |
| `ARUBA_ENVIRONMENT` | `demo` (default) oppure `production` |

L'ambiente `demo` usa i server di test Aruba (`demoauth`/`demows`): consigliato per le prime prove.

### Claude Code

```bash
claude mcp add aruba-fatture ^
  -e ARUBA_USERNAME=tuo_username ^
  -e ARUBA_PASSWORD=tua_password ^
  -e ARUBA_ENVIRONMENT=demo ^
  -- node <percorso-del-progetto>\dist\index.js
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aruba-fatture": {
      "command": "node",
      "args": ["<percorso-del-progetto>\\dist\\index.js"],
      "env": {
        "ARUBA_USERNAME": "tuo_username",
        "ARUBA_PASSWORD": "tua_password",
        "ARUBA_ENVIRONMENT": "demo"
      }
    }
  }
}
```

## Note operative

- **Invio a SDI**: `send_invoice` per default esegue solo la validazione (`dryRun=true`). L'invio reale avviene solo chiedendo esplicitamente di impostare `dryRun=false`.
- **Trasmittente**: le fatture inviate tramite Aruba devono riportare l'intermediario Aruba nell'`IdTrasmittente` (P.IVA `01879020517`).
- **Codice destinatario** per ricevere fatture su Aruba: `KRRH6B9`.
- **Rate limit Aruba**: 12 richieste/minuto per le ricerche, 30/minuto per gli upload; oltre soglia il server restituisce HTTP 429. Anche l'endpoint di autenticazione è soggetto a rate limit severi: il client serializza i login e riusa i token proprio per questo — in caso di 429 sull'autenticazione attendere qualche minuto.
- I contenuti base64 (XML/PDF) vengono omessi dalle risposte testuali per non saturare il contesto: usare `download_invoice` per salvarli su file.
- I token di accesso (30 min) e di refresh (60 min) sono gestiti automaticamente.

## Validazione XSD locale

In `test/` c'è una fattura di esempio e gli schemi XSD ufficiali FatturaPA v1.2.2. Per validare un XML senza passare dall'API (equivalente strutturale del `dryRun`):

```bash
pip install xmlschema
python -c "import xmlschema; s = xmlschema.XMLSchema('test/xsd/fatturapa.xsd', locations={'http://www.w3.org/2000/09/xmldsig#': 'test/xsd/xmldsig-core-schema.xsd'}); s.validate('test/esempio-fattura.xml'); print('VALIDA')"
```

## Esempi di richieste a Claude

- «Cerca le fatture ricevute la settimana scorsa»
- «Ci sono fatture scartate da SDI a luglio? Mostrami il motivo dello scarto»
- «Scarica il PDF della fattura IT01234567890_00042 in C:\fatture»
- «Valida questo XML prima dell'invio» (usa `send_invoice` con `dryRun=true`)

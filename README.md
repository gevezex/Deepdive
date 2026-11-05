# Deepdive
Read any article with ai aid

Zie [VISIE.md](VISIE.md) voor het idee, de functies en het bouwplan. Gebouwd is stap 1: bronnen openen.

## Starten

Nodig: Node, Rust en de systeemvereisten van [Tauri 2](https://tauri.app/start/prerequisites/).

```bash
npm install
```

```bash
npm run tauri dev
```

Een app bouwen op macOS:

```bash
npm run tauri build -- --bundles app
```

Tests:

```bash
npm test
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Frontend

Gewoon TypeScript met Vite, zonder framework. Stap 1 heeft maar een paar schermdelen en pdf.js werkt direct op de DOM, dus een framework voegt nu niets toe. Latere stappen, zoals de blauwdruk, kunnen er alsnog een krijgen.

## Opbouw

| Onderdeel | Taak |
|---|---|
| `src-tauri/src/engine/` | Laden van pagina's achter de trait `PageEngine`. Een andere engine, zoals CEF, hoeft alleen deze te implementeren. |
| `src-tauri/src/engine/capture.js` | Draait in de verborgen webview: wacht tot de pagina is opgebouwd, scrolt erdoorheen, haalt cookielagen weg en leest de DOM en tekstblokken uit. |
| `src-tauri/src/snapshot.rs` | Maakt de visuele kopie: saneert de HTML opnieuw en slaat afbeeldingen, CSS en fonts lokaal op. |
| `src-tauri/src/model.rs` | Het gezamenlijke bronmodel: blokken met vaste nummers, voor website, pdf en geplakte tekst. |
| `src-tauri/src/store.rs` | Opslag per bron in de app-datamap. |
| `src-tauri/src/import.rs` | Van invoer naar opgeslagen bron, en de beoordeling van wat er is opgehaald. |
| `src/pdf.ts`, `src/pdfBlocks.ts` | Pdf tonen met pdf.js en de tekst omzetten naar blokken. |

**Afscherming:** de kopie staat in een iframe met `sandbox=""` en een CSP zonder scripts en zonder netwerk. Het verborgen venster heeft geen capability, dus een pagina kan de commando's van de app niet aanroepen.

**Blokken in de kopie:** elk tekstblok heeft in de visuele kopie een attribuut `data-dd-n` met zijn alineanummer. Latere stappen kunnen tekst en beeld daarmee aan elkaar koppelen. Bij pdf's staan paginanummer en positie in het blok zelf.

## De site-test herhalen

De testhaak zit alleen in debug-builds. `docs/site-test-urls.txt` bevat de adressen, die na verloop van tijd kunnen verouderen.

```bash
npm run tauri build -- --debug --no-bundle
```

```bash
DEEPDIVE_DATA_DIR=/tmp/dd DEEPDIVE_SITE_TEST=docs/site-test-urls.txt DEEPDIVE_SITE_TEST_OUT=/tmp/dd.json src-tauri/target/debug/deepdive
```

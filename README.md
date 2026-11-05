# Deepdive
Read any article with ai aid

Zie [VISIE.md](VISIE.md) voor het idee, de functies en het bouwplan. Gebouwd zijn stap 1 (bronnen openen) en stap 2 (providers en modellen, met daarbij optioneel inloggen met ChatGPT).

Deepdive is open source onder de [MIT-licentie](LICENSE).

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
| `src-tauri/src/ai/` | De AI-laag: de enige plek die met een AI-dienst praat. Latere stappen gebruiken `ai::stream_chat` met een `Target` uit `ProviderStore::target`. |
| `src-tauri/src/providers/` | Providers en modellen in `providers.json`, sleutels via `secrets.rs` in de sleutelhanger. `Selection.perAction` is de voorbereiding op "model per actie". |
| `src-tauri/src/chatgpt/` | Inloggen met ChatGPT: login, ID-token, vernieuwen en uitloggen. De tokens staan alleen in de sleutelhanger. |
| `src-tauri/src/ai/responses.rs` | De Responses API voor het ChatGPT-abonnement, achter dezelfde ingang `ai::stream_chat`. |
| `src/providers.ts`, `src/providerLogic.ts` | Het providerscherm en de modelkiezer. |

**Afscherming:** de kopie staat in een iframe met `sandbox=""` en een CSP zonder scripts en zonder netwerk. Het verborgen venster heeft geen capability, dus een pagina kan de commando's van de app niet aanroepen.

**Blokken in de kopie:** elk tekstblok heeft in de visuele kopie een attribuut `data-dd-n` met zijn alineanummer. Latere stappen kunnen tekst en beeld daarmee aan elkaar koppelen. Bij pdf's staan paginanummer en positie in het blok zelf.

**API-sleutels:** alleen in de sleutelhanger. De frontend geeft een sleutel door aan Rust en krijgt alleen `hasKey` terug. `ApiKey` is niet te serialiseren, foutmeldingen gaan door `errors::redact`, doorverwijzingen worden niet gevolgd en een sleutel gaat alleen via https of naar deze computer. Na een nieuwe build kan macOS opnieuw om toegang tot de sleutelhanger vragen, omdat de app dan niet meer dezelfde handtekening heeft.

**ChatGPT-tokens:** één item per koppeling in de sleutelhanger, onder `chatgpt:<provider-id>`. De frontend krijgt alleen het e-mailadres en de status. De adressen van OpenAI staan in een release-build vast; alleen debug-builds kunnen naar een lokale nepserver wijzen. In `chatgpt-host-id` in de app-datamap staat de anonieme ID van deze installatie, die geen geheim is.

## Inloggen met ChatGPT

Dit volgt [OpenAI's beschrijving voor open-source apps](https://developers.openai.com/siwc/token-sharing-open-source), die nog in preview is. Elke gebruiker koppelt een eigen account en abonnement. Er zit geen gedeelde sleutel in de app en er is geen server.

Zelf proberen: open **Providers**, kies **Nieuwe provider** en klik op **Continue with ChatGPT**. Log in je browser in en geef toestemming. Daarna kies je een model bovenin het rechterpaneel. Uitloggen kan via de provider.

## De end-to-endtest van de providers

Bedient de echte app en de echte sleutelhanger met een nepsleutel onder een eigen dienstnaam, tegen de lokale nepserver in `tests/e2e/mock-ai.mjs`. Er is geen echte provider of sleutel voor nodig.

```bash
npm run tauri build -- --debug --no-bundle --features screenshots
```

```bash
node tests/e2e/providers.e2e.mjs
```

De test van inloggen met ChatGPT werkt net zo, tegen een lokale nep van OpenAI in `tests/e2e/mock-chatgpt.mjs`. Hij gebruikt geen echt account:

```bash
node tests/e2e/chatgpt.e2e.mjs
```

De test met de echte sleutelhanger op Rust-niveau:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored keychain
```

## De site-test herhalen

De testhaak zit alleen in debug-builds. `docs/site-test-urls.txt` bevat de adressen, die na verloop van tijd kunnen verouderen.

```bash
npm run tauri build -- --debug --no-bundle
```

```bash
DEEPDIVE_DATA_DIR=/tmp/dd DEEPDIVE_SITE_TEST=docs/site-test-urls.txt DEEPDIVE_SITE_TEST_OUT=/tmp/dd.json src-tauri/target/debug/deepdive
```

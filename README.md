# Deepdive
Read any article with ai aid

Zie [VISIE.md](VISIE.md) voor het idee, de functies en het bouwplan. Gebouwd zijn stap 1 (bronnen openen), stap 2 (providers en modellen, met daarbij optioneel inloggen met ChatGPT) en stap 3 (de blauwdruk).

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
npx tsc --noEmit
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Frontend

Gewoon TypeScript met Vite, zonder framework. De schermdelen zijn klein en pdf.js werkt direct op de DOM, dus een framework voegt nu niets toe.

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
| `src-tauri/src/blueprint/` | De blauwdruk: schema, prompts en controles (`schema.rs`, `prompts/`, `validate.rs`), de twee aanroepen (`mod.rs`), het lezen van een antwoord terwijl het binnenkomt (`stream.rs`), de opslag (`saved.rs`) en de opdrachten voor de interface (`commands.rs`). |
| `src/blueprint.ts`, `src/blueprintLogic.ts` | Het paneel: knop, voortgang, de drie lagen en het eigen diagram. |
| `src-tauri/src/engine/bridge.js` | Het enige script in de websitekopie: geeft de selectie door, tekent markeringen en springt naar alinea's. |
| `src-tauri/src/professor/` | Selecteren en vragen: de prompt (`prompts/system.md`, de opdracht per actie in `mod.rs`), gesprekken per bron in `threads/` en markeringen in `highlights.json` (`highlights.rs`). |
| `src/reading.ts`, `src/answers.ts`, `src/readingLogic.ts` | De selectiebalk met het ⋯-menu, markeren met notitie, en de antwoorden in het tabblad Vragen. |

**Afscherming:** de kopie staat in een iframe met `sandbox="allow-scripts"`, zonder `allow-same-origin`, en een CSP zonder netwerk. De scripts van de site zitten niet in de kopie. Bij het serveren zet de app er één eigen script in (`engine/bridge.js`). De CSP in de kop laat alleen dat script toe, op zijn sha-256-hash: geen ander inline script, geen handlers in attributen en geen script van een adres. De CSP die in de opgeslagen pagina staat, gaat bij het serveren weg, want die verbiedt alle scripts. Het script heeft een eigen, ondoorzichtige origin en praat alleen via `postMessage` met het hoofdvenster. Het hoofdvenster neemt alleen berichten van die iframe aan en gebruikt daaruit alleen tekst en getallen. Het verborgen venster heeft geen capability, dus een pagina kan de commando's van de app niet aanroepen.

**Voorvertoning:** zodra er tekst staat, toont de app de pagina al terwijl de kopie op de achtergrond wordt gemaakt. Die voorvertoning krijgt dezelfde opschoning en sandbox, zonder scripts, maar laadt afbeeldingen, CSS en fonts nog rechtstreeks van de site. Ze staat alleen in het geheugen.

**Blokken in de kopie:** elk tekstblok heeft in de visuele kopie een attribuut `data-dd-n` met zijn alineanummer. Latere stappen kunnen tekst en beeld daarmee aan elkaar koppelen. Bij pdf's staan paginanummer en positie in het blok zelf.

**Popups in de kopie:** zonder scripts is een laag niet weg te klikken. Daarom gebeurt er twee dingen. Bij het vastleggen haalt `capture.js` cookielagen en inschrijf-, nieuwsbrief- en app-lagen weg, en zet het scrollen weer aan als de pagina dat had uitgezet. Een laag die zonder sluitknop vraagt om in te loggen of te betalen blijft staan. Blijft er toch iets hinderen, dan is er de knop **Popup weghalen** onder de kopie. De keuze staat als `hideFloating` in `source.json`. Bij het serveren voegt de app dan een stijl toe die verbergt wat volgens de CSS van de kopie zweeft (`position: fixed`, dialogen, en `position: absolute` met een z-index vanaf 1000). Elementen met of rond een genummerde alinea blijven altijd staan. De kopie op schijf, de tekst en het oordeel over de volledigheid veranderen niet, en de afscherming blijft gelijk. De kopie laadt opnieuw en begint dan bovenaan. Opnieuw ophalen neemt de keuze mee naar de nieuwe kopie.

**Springen in de kopie:** het eigen script scrolt naar de alinea's en laat ze oplichten, zonder dat de pagina opnieuw laadt. Het laatste doel staat in `data-jump` op de iframe. Is het script er nog niet, bijvoorbeeld tijdens de voorvertoning, dan vraagt de iframe een nieuw adres op: `index.html?hl=31-40#dd-doel`. De server zet dan een stijl in de pagina en de browser scrolt zelf naar het anker. Uit de query komen alleen getallen. Een pdf staat niet in een iframe: daar komt een markering op de pagina, op de plek uit het blok.

**Selecteren en vragen:** bij een selectie verschijnt een balk met een vraagveld, Leg uit, Eenvoudiger, ⋯ (Wat betekent dit woord?, Klopt dit nog?, Waar komt dit nog terug?, Tegenargument, Citaat kopiëren), Markeren en Notitie. Typ je terwijl er iets geselecteerd is, dan gaan de letters naar het vraagveld. De vraag gaat met de hele bron, de selectie en de alineanummers naar het model dat bij Model is gekozen (`model_for_action("ask")`). Het antwoord komt in het tabblad Vragen en wordt per bron bewaard, met vervolgvragen. "Klopt dit nog?" zoekt nog niet op het web: het model zegt wat het weet en dat het niet is nagezocht.

**Markeren:** vier kleuren. Klik op een markering voor een andere kleur, een notitie, Leg uit of weghalen. De kopie verandert nooit, dus een plek ligt vast: bij een website als tekenpositie in de tekst van de pagina, bij een pdf als rechthoeken op de pagina.

**Blauwdrukken:** per bron, model en promptversie één bestand in `sources/<id>/blueprints/`. De iframe kan die map niet opvragen. Opnieuw openen roept geen model aan. Een onvolledige blauwdruk vervangt nooit een volledige van hetzelfde model.

**API-sleutels:** alleen in de sleutelhanger. `CachedSecrets` leest elk item één keer per sessie en houdt het daarna alleen in het geheugen van de app. De frontend geeft een sleutel door aan Rust en krijgt alleen `hasKey` terug. `ApiKey` is niet te serialiseren, foutmeldingen gaan door `errors::redact`, doorverwijzingen worden niet gevolgd en een sleutel gaat alleen via https of naar deze computer. Na een nieuwe build kan macOS opnieuw om toegang tot de sleutelhanger vragen, omdat de app dan niet meer dezelfde handtekening heeft.

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

## De end-to-endtest van de blauwdruk

Bedient de echte app tegen de lokale nepserver: knop, stap voor stap tonen, springen, afbreken, meldingen, bewaren en opnieuw openen. Er is geen echt model of sleutel voor nodig. Bouwen gaat zoals hierboven.

```bash
node tests/e2e/blueprint.e2e.mjs
```

## De end-to-endtest van selecteren en markeren

Bedient de echte app tegen de lokale nepserver. In de websitekopie kan de test niet zelf selecteren, omdat de iframe is afgeschermd. De test controleert daarom dat het eigen script daar draait, en speelt daarna zijn berichten na. In de pdf selecteert de test echt. Bouwen gaat zoals hierboven.

```bash
node tests/e2e/reading.e2e.mjs
```

## De end-to-endtest van de popups

Bedient de echte app tegen de lokale testsite `tests/e2e/mock-site.mjs`, zonder echte sites of accounts:

```bash
npm run tauri build -- --debug --no-bundle --features screenshots
```

```bash
node tests/e2e/popups.e2e.mjs
```

## De site-test herhalen

De testhaak zit alleen in debug-builds. `docs/site-test-urls.txt` bevat de adressen, die na verloop van tijd kunnen verouderen.

```bash
npm run tauri build -- --debug --no-bundle
```

```bash
DEEPDIVE_DATA_DIR=/tmp/dd DEEPDIVE_SITE_TEST=docs/site-test-urls.txt DEEPDIVE_SITE_TEST_OUT=/tmp/dd.json src-tauri/target/debug/deepdive
```

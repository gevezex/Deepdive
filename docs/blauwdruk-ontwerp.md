# Blauwdruk: ontwerp en testresultaten

Stap 3a legde de blauwdruk vast als data en testte de kwaliteit. Stap 3b bracht het schema naar versie 2 en zette de blauwdruk in de app. De eerste helft van dit document beschrijft het huidige ontwerp, [Test van stap 3a](#test-van-stap-3a) de oorspronkelijke meting en [Stap 3b](#stap-3b) wat er daarna is veranderd.

## Conclusie

- Doel, boodschap en structuur zijn op beide modellen bruikbaar.
- ChatGPT is de betere standaard: snel, en weinig ruis.
- Sushi vindt meer, maar levert ook meer ruis en is ruim vier keer zo traag.
- Versie 2 scheidt lof, kritiek en begrippen, en de zekerheid zegt nu iets. Op de kleine set wijst geen enkel punt meer te breed.

## Schema

Het schema staat in `src-tauri/src/blueprint/schema.rs` en heeft versienummer 2. De opdrachten aan het model hebben een eigen versienummer, `PROMPT_VERSION`, dat ook 2 is.

| Laag | Inhoud |
|---|---|
| 1. Doel | Hoofddoel en bijdoelen, boodschap in één zin, aanleiding, samenvatting, soort tekst |
| 2. Structuur | Blokken met rol, inhoud en alinea's; relaties tussen blokken |
| 3. Kritiek | Punten aan een blok of relatie, met soort, plus of min, gezegd of afgeleid, zekerheid, alinea's en citaten. Daarnaast een hulplijst met begrippen, die niet als punt telt |

Bij de kritiek hoort per onderdeel een uitkomst: gevonden, niets gevonden of niet van toepassing. "Geen gat gevonden" is daarmee een geldige uitkomst, en een memoire hoeft niets te bewijzen.

Elke blauwdruk bewaart ook de status van de bron. Is die waarschijnlijk onvolledig, dan staat die waarschuwing in het resultaat. De taal is standaard Nederlands en instelbaar; citaten blijven in de brontaal.

## Twee aanroepen

Eén aanroep is goedkoper, maar dan kan de kritiek zijn eigen structuur verzinnen. Daarom zijn het er twee:

1. **Structuur:** doel, boodschap, aanleiding, samenvatting, blokken en relaties, in die volgorde. Een scherm kan zo het doel al tonen terwijl de rest nog binnenkomt.
2. **Kritiek:** krijgt de gecontroleerde structuur als vast gegeven en verwijst alleen met de ids daaruit. De delen kunnen elkaar zo niet tegenspreken.

Beide aanroepen beginnen met dezelfde tekst, zodat de provider die kan hergebruiken. Klopt het schema niet, dan volgt één herstelpoging. Mislukt alleen de kritiek, dan blijft de structuur staan, met een melding.

## Controles

`validate.rs` controleert elke uitkomst met code:

| Controle | Bij een fout |
|---|---|
| Schema | Eén herstelpoging, daarna een foutmelding |
| Alinea's bestaan | Bereik wordt ingekort of weggehaald |
| Relaties wijzen naar bestaande blokken, zonder kringen | Relatie wordt weggehaald |
| Kritische punten hangen aan iets dat bestaat | Punt wordt weggehaald |
| Citaat staat letterlijk in de bron | Verplaatst naar de juiste alinea, of weggehaald |
| Punt wijst naar meer dan 8 alinea's, of naar minstens 5 en meer dan de helft van het stuk | Gemarkeerd als breed; springen gaat naar de eerste alinea |

Er wordt nooit een verwijzing verzonnen, en elke reparatie komt in het resultaat te staan. Vóór het versturen rekent de code uit of de tekst in het model past. Past die niet, dan gaat er niets weg.

De brontekst staat tussen een tag met een willekeurige code en geldt als bron, niet als instructie.
## Test van stap 3a

De cijfers hieronder gaan over schema versie 1.

- **Stukken:** 19 echte stukken (nieuws, opinie, essay, recensie, blog, onderzoek, naslag, 2 open pdf's en 1 bewust onvolledig stuk) en 6 eigen testteksten. De lijst staat in `docs/blauwdruk-test/selectie.txt`, de antwoorden in `docs/blauwdruk-test/fixtures/VERWACHT.md`.
- **Modellen:** ChatGPT `gpt-6.1-sol` en lokaal `GLM-5.3-Flash-Sushi-2.4bpw`, via de providers in de app.
- **Aanroepen:** 117 in totaal: 9 in de proefronde en 108 in de volledige run (ChatGPT 51, Sushi 57). Daarvan zijn 8 herstelpogingen na een schemafout. De twee proefstukken zijn twee keer gedraaid, de rest één keer per model.

### Metingen

| | ChatGPT | Sushi |
|---|---|---|
| Blauwdruk gelukt | 25 van 25 | 25 van 25 |
| Schema meteen goed | 24 van 25 | 19 van 25 |
| Mediane duur | 82 s | 347 s |
| Langste duur | 185 s | 856 s |
| Mediane tijd tot het doel | 15 s | 82 s |
| Citaten letterlijk gevonden | 79 van 79 | 329 van 330, 1 weggehaald |
| Verwijzingen gerepareerd | 0 | 0 |
| Kritische punten | 79 | 165 |
| Punten met hoge zekerheid | 77 | 83 |
| Punten over voorkennis | 16 | 39 |
| Punten die naar meer dan 20 alinea's wijzen | 0 | 16 |
| Stukken op het maximum van 8 punten | 0 | 14 |

De duren laten het NOS-stuk weg, omdat de run daar op een sleutelhangermelding wachtte. De cijfers per stuk staan in `docs/blauwdruk-test/resultaten.json`.

**Context:** alles paste. Het langste stuk telt 11.883 woorden, ongeveer 22.000 tokens, tegenover 500.000 bij ChatGPT en ruim 1 miljoen bij Sushi. De weigering bij een te lange tekst is alleen met een unit-test geprobeerd, niet met een echt model. Sushi geeft geen tokenaantallen terug.

### Eigen testteksten

| Tekst | ChatGPT | Sushi |
|---|---|---|
| Kloppend bewijs | Goed: nul punten | Fout: een aanname met hoge zekerheid |
| Vijf geplante fouten | Alle vijf, twee in één punt | Alle vijf |
| Spiegelbeeld voor en tegen | 5 en 4 punten | 8 en 7 punten |
| Instructies in de bron | Niet opgevolgd | Niet opgevolgd |
| Memoire | Goed | Goed |
| Onvolledig stuk | Status komt mee | Status komt mee |

### Oordeel, los van de metingen

Dit is de inschatting van Claude. Alle testteksten zijn met de antwoorden vergeleken. Van de echte stukken zijn alle punten in verkorte vorm gelezen, maar is slechts een steekproef van ongeveer vijftien punten met de bron vergeleken. Daarin zat geen punt dat de tekst verkeerd weergeeft, wel een paar die te streng of te klein zijn. Het oordeel van de gebruiker in het overzicht ontbreekt nog en weegt zwaarder.

### Beperkingen

- De geplante fouten zijn vrij duidelijk, en het koffiebericht is ook gebruikt om de prompt bij te stellen.
- De open lijsten bevatten geen echt paar tegengestelde opiniestukken. Gelijke strengheid is getest op één zelfgeschreven paar, en er zit maar één echt opiniestuk in de test.
- Sushi is alleen op deze machine en met deze instellingen gemeten.
- Het overzicht is in de browser nagekeken, behalve de knop om oordelen als bestand te bewaren.

## Stap 3b

### Schema versie 2

| Wens uit stap 3a | Wat er nu is |
|---|---|
| Plus of min per punt | Verplicht veld `polarity`. Een plus is groen en krijgt een +, een min is warmbruin en krijgt een − |
| Voorkennis apart | Geen kritisch onderdeel meer, maar een eigen lijst `terms`, ingeklapt onder de kritiek |
| Zekerheid | Vaste criteria per niveau in de prompt. Het veld blijft zichtbaar, omdat het nu iets zegt: zie hieronder |
| Brede verwijzingen | De prompt vraagt om hooguit vijf alinea's. De controle markeert wat te breed blijft |

### Nieuwe meting

Vijf stukken met ChatGPT `gpt-6.1-sol` en twee korte met Sushi. De cijfers staan in `docs/blauwdruk-test/resultaten-v2.json`.

| Stuk en model | Punten v1 (waarvan voorkennis) | Punten v2 | Begrippen | Plus | Zekerheid hoog / gemiddeld | Duur v1 en v2 |
|---|---|---|---|---|---|---|
| `fouten-koffie`, ChatGPT | 5 (0) | 4 | 0 | 0 | 3 / 1 | 62 s, 53 s |
| `schoon-priemgetallen`, ChatGPT | 0 (0) | 0 | 1 | 0 | geen punten | 38 s, 38 s |
| `memoire-camino`, ChatGPT | 3 (0) | 3 | 0 | 0 | 2 / 1 | 49 s, 42 s |
| `guardian`, ChatGPT | 4 (0) | 3 | 4 | 0 | 0 / 3 | 98 s, niet bruikbaar |
| `devto`, ChatGPT | 4 (2) | 2 | 6 | 1 | 1 / 1 | 85 s, 73 s |
| `fouten-koffie`, Sushi | 8 (0) | 7 | 0 | 1 | 2 / 5 | 153 s, 394 s |
SUSHI_SCHOON_RIJ

- **Zekerheid:** bij ChatGPT was in stap 3a 77 van de 79 punten hoog. Op deze set is dat 6 van de 12, en bij Sushi 2 van de 7. Daarom blijft het veld staan, bij het uitgeklapte punt. Met zo weinig punten is dit een aanwijzing en geen bewijs.
- **Breedte:** geen enkel punt is breed; het breedste wijst naar 4 alinea's. In stap 3a zaten de ergste gevallen in lange stukken (Sushi tot 287 alinea's in de PLOS-pdf), en die zijn niet opnieuw gedraaid met Sushi. De prompt is daar dus niet op getest. De markering is dat wel, met tests.
- **Geplante fouten:** ChatGPT benoemt in `fouten-koffie` vier van de vijf duidelijk. De zwakke test als meetinstrument komt alleen zijdelings terug ("eenmalige online denktest"). Sushi noemt alle vijf.
- **Niets verzinnen:** `schoon-priemgetallen` levert bij ChatGPT nul punten en één begrip op. `memoire-camino` krijgt bij bewijs "niet van toepassing".
- **Lof:** de pluspunten die er zijn, zijn terecht of klein. Sushi prijst dat het koffiebericht de financier noemt, wat aan de magere kant is.
- **De duren zijn niet zuiver.** `guardian` wachtte op een sleutelhangermelding. Sushi op `fouten-koffie` deelde de server even met een dubbele run door een fout in het testscript, die nu is opgelost.
- **Sushi:** de eerste poging op `schoon-priemgetallen` kreeg bij de kritiek "overbelast" terug, en later reageerde de server even helemaal niet. De oorzaak is niet onderzocht. Beide meldingen kwamen wel goed in beeld, en de structuur bleef staan.

Dit oordeel is weer dat van Claude. De steekproef is klein en het oordeel van de gebruiker ontbreekt nog.

### Wat er in de app zit

- **Knop in het rechterpaneel.** Het model is wat de lezer in de modelkiezer heeft gekozen. Zonder keuze stelt het paneel ChatGPT voor als dat gekoppeld is, maar er wordt pas gekozen na een klik.
- **Stap voor stap.** `stream.rs` leest doel, boodschap en blokken uit het antwoord terwijl het binnenkomt. Dat is ongecontroleerd en alleen om te tonen. De gecontroleerde structuur vervangt het daarna. Bij een tweede poging gaat wat er stond eerst weg.
- **Afbreken** laat de lopende aanroep vallen, wat de verbinding sluit. Tijdens de structuur blijft er niets over. Tijdens de kritiek blijven doel en diagram bewaard, en kan de lezer later alleen de kritiek maken.
- **Doorlezen kan.** Een blauwdruk loopt door als de lezer een ander stuk opent, en is er nog bij terugkomst.
- **Diagram.** Blokken staan in tekstvolgorde onder elkaar, omdat dat in een smal paneel leesbaar blijft. Pijlen lopen in hooguit vier banen links ervan. Vlak boven elk blok staan de pijlen die erin komen, met hun uitleg en punten. Dat is eigen HTML en SVG uit de data, zonder Mermaid.
- **Bewaren.** Per bron, model en promptversie, meteen na de structuur en opnieuw na de kritiek. Een onvolledige blauwdruk vervangt nooit een volledige van hetzelfde model.
- **Sleutel.** `CachedSecrets` leest elk item één keer per sessie. Dat geldt ook voor de ChatGPT-tokens, die anders bij elk verzoek werden gelezen.

Hoe springen werkt binnen de afscherming staat in `README.md`.

### Open punten

- **De gewone app is nog niet ondertekend.** Zonder vaste handtekening vraagt macOS na elke nieuwe build opnieuw om toegang tot de sleutelhanger. De test in de echte app stond daardoor ongeveer 20 minuten stil. De voortgang noemt die mogelijkheid nu na 20 seconden.
- **Springen laadt de kopie opnieuw.** Bij een zware pagina kan dat even zichtbaar zijn.
- **Er is geen donkere stand,** omdat de app die nog niet heeft.
- **De taal** staat vast op Nederlands en zit niet in de bewaarnaam. Maak je dat instelbaar, neem de taal dan mee in die naam.
- **Tijdens het streamen** kan een blok nog naar een alinea wijzen die niet bestaat. Springen doet dan niets, tot de controle het heeft hersteld.
- **Het overzicht van stap 3a** (`scripts/blauwdruk-overzicht.mjs`) kent plus of min en begrippen nog niet.

## Opnieuw draaien

```bash
node scripts/blauwdruk-test.mjs fetch
```

```bash
node scripts/blauwdruk-test.mjs run
```

Alleen een paar stukken en één model:

```bash
MODELS=chatgpt node scripts/blauwdruk-test.mjs run fouten-koffie schoon-priemgetallen
```

```bash
node scripts/blauwdruk-overzicht.mjs
```

Artikelen, modeluitvoer en het overzicht staan in de git-genegeerde map `.blauwdruk-test/`. Die verdwijnt als de worktree wordt opgeruimd.

# Blauwdruk: ontwerp en testresultaten (stap 3a)

Stap 3a legt de blauwdruk vast als data en test de kwaliteit. Er is nog geen knop, paneel of diagram in de app; dat is stap 3b.

## Conclusie

- Doel, boodschap en structuur zijn op beide modellen bruikbaar.
- ChatGPT is de betere standaard: snel, en weinig ruis.
- Sushi vindt meer, maar levert ook meer ruis en is ruim vier keer zo traag.
- De kritische laag moet nog op drie punten veranderen voordat er een scherm op komt: zie [Wat stap 3b nodig heeft](#wat-stap-3b-nodig-heeft).

## Schema

Het schema staat in `src-tauri/src/blueprint/schema.rs` en heeft versienummer 1.

| Laag | Inhoud |
|---|---|
| 1. Doel | Hoofddoel en bijdoelen, boodschap in één zin, aanleiding, samenvatting, soort tekst |
| 2. Structuur | Blokken met rol, inhoud en alinea's; relaties tussen blokken |
| 3. Kritiek | Punten aan een blok of relatie, met soort, gezegd of afgeleid, zekerheid, alinea's en citaten |

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

Er wordt nooit een verwijzing verzonnen, en elke reparatie komt in het resultaat te staan. Vóór het versturen rekent de code uit of de tekst in het model past. Past die niet, dan gaat er niets weg.

De brontekst staat tussen een tag met een willekeurige code en geldt als bron, niet als instructie. De code heeft 25 tests.

## Test

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

## Wat stap 3b nodig heeft

Eerst in het schema, in versie 2:

1. **Plus of min per punt.** De prompt vraagt ook om opvallend sterk bewijs, maar nu lijkt lof op het scherm op een gebrek.
2. **Voorkennis apart.** Begrippen zijn een hulplijst en geen kritiek, en vullen nu 55 van de 244 punten.
3. **Zekerheid opnieuw bepalen.** Bij ChatGPT is bijna alles hoog. Geef vaste criteria per niveau, of toon het veld niet.

Daarna in de prompt en de controles:

4. **Brede verwijzingen weigeren of markeren.** De controle moet ook naar de omvang kijken. Daarna de punten opnieuw meten op een kleine set.

In de app:

5. **ChatGPT als standaard,** met Sushi als lokale, langzamere keuze waarbij de duur vooraf wordt genoemd.
6. **Voortgang tonen en het doel meteen laten zien.** Zelfs bij ChatGPT duurt het 15 seconden tot het doel en anderhalve minuut tot het geheel. Bij Sushi kan het een kwartier duren.
7. **Eén keer maken en bewaren,** per bron, model en promptversie, zoals `VISIE.md` vraagt.
8. **De waarschuwing voor een onvolledige bron bovenaan** tonen, en de dekking niet als kwaliteitscijfer gebruiken. Bij WIRED is die laag doordat de rest van de pagina navigatie is.
9. **De sleutel één keer per sessie lezen** en de gewone app echt ondertekenen. Nu leest `providers/mod.rs` de sleutel per aanroep, wat bij een testbouw herhaalde sleutelhangermeldingen geeft.

## Opnieuw draaien

```bash
node scripts/blauwdruk-test.mjs fetch
```

```bash
node scripts/blauwdruk-test.mjs run
```

```bash
node scripts/blauwdruk-overzicht.mjs
```

Artikelen, modeluitvoer en het overzicht staan in de git-genegeerde map `.blauwdruk-test/`. Die verdwijnt als de worktree wordt opgeruimd.

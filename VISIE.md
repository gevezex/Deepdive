# Deepdive — visie

> Samen lezen en leren met een AI-coach, op alles wat je leest.

## Het idee

Je leest iets wat niet makkelijk is: een artikel in de browser, een pdf, een stencil, een bladzijde uit een boek. Op het moment dat je vastloopt, druk je op een sneltoets, trek je een kader om het stuk dat je niet snapt en kies je wat je wilt: uitleg, Jip-en-Janneke-taal, voorbeelden, een tekening.

Er is niets te kopiëren of te plakken. Deepdive kijkt mee op je scherm en weet uit welk stuk je selectie komt. Daardoor gaat de uitleg over jouw stuk in zijn verband, en niet over een losse alinea.

Deepdive is geen vraagjes-tool maar een **leescoach**. Hij geeft je eerst het grote plaatje, laat zien waar je bent, legt uit, tekent mee en vraagt je af en toe iets terug.

## Voor wie

- **Jezelf**: verdiepen in moeilijke teksten.
- **Docenten**: een onderwerp uitzoeken en daar een les van maken.
- **Leerlingen en studenten**: later, via een gedeeld project of een eigen account.

---

## Kernfuncties

### 1. Kader trekken, overal

```
Ctrl/Cmd + Shift + Spatie
  → scherm wordt licht grijs
  → kader trekken om alinea, zin, grafiek of formule
  → paneel naast de selectie:

  🗺️ Waar gaat dit over?   🧒 Jip & Janneke    💡 Leg beter uit
  ❓ Wat bedoelt hij?       📋 Geef voorbeelden  ✏️ Teken het
  🎓 Overhoor me            [ eigen vraag... ]
  → antwoord in zijpaneel, doorvragen kan
```

Dit werkt op alles wat op het scherm staat: browser, pdf-lezer, foto, Word.

### 2. De kapstok: "Waar gaat dit over?"

Je krijgt het grote plaatje vóórdat je de details leest, zodat alles daarna een plek heeft. In de onderwijskunde heet dit een *advance organizer*.

| Onderdeel | Vraag die het beantwoordt |
|---|---|
| De kern in één zin | Wat wil de auteur dat ik onthoud? |
| Het probleem of de vraag | Waarom is dit geschreven? Wat klopt er niet of wat ontbreekt er? |
| De lijn van het betoog | Hoe is het opgebouwd? Bijvoorbeeld probleem → oorzaak → oplossing → bezwaren. |
| Verbanden | Welke begrippen en ideeën knoopt de auteur aan elkaar (begrippenkaart)? |
| Voorkennis | Welke woorden of begrippen worden bekend verondersteld? |
| Lastige stukken | Waar moet je langzaam lezen? |

De kapstok is bij voorkeur een **kaartje** (blokjes met pijlen) en geen lap tekst.

**De kapstok blijft meedoen tijdens het lezen:**
- Hij staat ingeklapt bovenaan het paneel en is altijd bij de hand.
- **"Je bent hier"**: bij elke selectie licht op de kaart op bij welk onderdeel die hoort.
- Uitleg verwijst terug, bijvoorbeeld: "Dit is het bezwaar uit stap 3."
- Je kunt inzoomen: het hele stuk, dit hoofdstuk, deze alinea.
- Bij een lang stuk verschijnt de kapstok **automatisch** zodra je begint.

### 3. Uitleg op maat

- **Jip & Janneke**: eenvoudige taal, zonder vakjargon.
- **Leg beter uit**: dezelfde inhoud op een andere manier.
- **Wat bedoelt hij?**: de bedoeling achter een zin, inclusief ironie of wat er tussen de regels staat.
- **Voorbeelden**: concreet en herkenbaar.
- **Teken het**: diagram, tijdlijn, schema of begrippenkaart (SVG of Mermaid).
- **Eigen vraag**: vrij doorvragen.

### 4. De coach vraagt terug

De coach legt niet alleen uit, hij **activeert** ook:
- "Wat denk je dat de auteur hierna gaat zeggen?"
- Een controlevraag na een lastig stuk.
- **Overhoor me**: vragen over wat je net gelezen hebt, met bijhouden wat je goed of fout had.

---

## Context: de app moet het hele stuk kennen

Een overzicht van alleen wat op het scherm staat, is een overzicht van een half artikel. Deepdive haalt daarom per soort bron de volledige tekst op:

| Bron | Hoe Deepdive het hele stuk kent |
|---|---|
| Webartikel | De browserextensie geeft de volledige tekst en URL door. |
| PDF | De app opent het bestand en leest alle bladzijden. |
| Stencil of boek | Een reeks foto's ("bladzijde 1 t/m 4") wordt één bron, bijvoorbeeld vanaf je telefoon via een QR-code. |
| Overig scherm | De vensternaam en titel via de toegankelijkheidsfuncties van het OS, plus een schermafbeelding. |

De selectie (het kader) gaat als afbeelding naar de coach, en de volledige bron gaat mee als context.

---

## Projecten: één Deepdive per onderwerp

Alles over één onderwerp blijft bij elkaar in een project.

```
📁 Deepdive: "Klimaatakkoord van Parijs"
 ├─ 📄 Bronnen        artikel (link + tekst), pdf, foto's van een stencil
 ├─ 🗺️ Kapstok        overzicht + kaartje van het geheel (over alle bronnen samen)
 ├─ 🔍 Uitdiepingen   elk kader: uitsnede, vraag, antwoord, plek in de kapstok
 ├─ ✏️ Diagrammen     alles wat de coach heeft getekend
 ├─ 🎓 Vragen         overhoorvragen + resultaten
 └─ 📝 Notities       eigen aantekeningen
```

- Een project kan **meerdere bronnen** hebben. De coach legt verbanden tussen bronnen ("dit zegt het artikel ook, maar anders").
- Projecten worden **lokaal** opgeslagen als map of bestand, zonder dat je een server nodig hebt.

### Delen

| Manier | Wat de ander krijgt | Handig voor |
|---|---|---|
| Projectbestand (`.deepdive`) | Alles, en de ander kan in Deepdive zelf verder vragen en verdiepen | Samenwerken met een collega |
| Weblink | Een leesbare pagina met kapstok, diagrammen en uitleg | Leerlingen, mensen zonder de app |
| Export | PDF of slides | Printen, presenteren |

**Auteursrecht:** bij delen gaan van webartikelen standaard alleen de link en de citaten mee, niet de volledige tekst. Bij eigen pdf's en foto's kiest de gebruiker.

### Les voorbereiden: "Maak hier een les van"

Uit een project maakt de coach:
- een **lesopbouw** met de kapstok als rode draad
- **uitleg op leerlingniveau** (de Jip-en-Janneke-versies zijn er al)
- **diagrammen** voor op het bord
- een **werkblad of toetsvragen** uit de overhoorvragen
- **"waar leerlingen gaan vastlopen"**: precies de stukken waar jij zelf vragen over had

---

## Techniek

Cross-platform: **Windows en macOS**.

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Desktop-app | **Tauri 2** (Rust + web-UI in TypeScript) | Eén codebase voor beide OS'en, klein (±10 MB) en snel |
| Sneltoets | `tauri-plugin-global-shortcut` | Werkt op beide OS'en |
| Schermopname | `xcap` (Rust) | Werkt op beide OS'en, ook met meerdere schermen |
| Overlay | Transparant venster over het hele scherm, altijd bovenop | Kader trekken over elke app |
| Browserextensie | WebExtension (Chrome, Edge, Firefox) | Volledige artikeltekst; praat met de app via een lokale verbinding |
| AI | Claude API (`@anthropic-ai/sdk`), met beeld en streaming | Selectie als afbeelding plus bron als context; antwoord verschijnt direct |
| Diagrammen | SVG en Mermaid, gerenderd in het paneel | Claude tekent uitlegschema's goed |
| Opslag | Lokaal: projectmap of `.deepdive` (zip met JSON, afbeeldingen en bronnen) | Geen server nodig, makkelijk te delen |

Aandachtspunten:
- **macOS** vraagt één keer om de rechten "Schermopname" en "Toegankelijkheid".
- **API-sleutel**: voor jezelf lokaal in de instellingen. Voor leerlingen later via een eigen kleine server, zodat de sleutel niet in de app staat.

---

## Volgorde van bouwen

1. **Basis**: sneltoets, kader, knoppen en antwoord in het zijpaneel. Daarmee werkt het al overal.
2. **Kapstok**: het overzicht, het kaartje, "je bent hier" en terugverwijzen.
3. **Projecten**: lokaal opslaan, bronnen, uitdiepingen en notities.
4. **Browserextensie**: de volledige artikeltekst als context.
5. **Ingebouwde lezer**: pdf's, foto's en een fotoreeks vanaf de telefoon.
6. **Coach vraagt terug**: Overhoor me, voorspelvragen, resultaten bijhouden.
7. **Delen en les maken**: `.deepdive`-bestand, export, weblink, "Maak hier een les van".

## Open vragen

- Moet een project automatisch starten bij een nieuwe bron, of kies je zelf "Nieuwe deepdive"?
- Hoe veel moet de coach terugvragen? Instelbaar per project?
- Weblinks: zelf hosten, of als statische pagina exporteren?
- Leerlingversie: eigen accounts en een server, of alleen gedeelde projecten?
- Taal: altijd Nederlands, of in de taal van de bron?

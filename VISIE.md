# Deepdive — visie

> Een persoonlijke professor naast alles wat je leest.

## Het idee

Je wilt iets echt begrijpen: een krantenartikel, een opiniestuk, een onderzoekspaper, een essay. Je plakt of sleept de URL of pdf in de Deepdive-app. Links verschijnt het stuk in zijn eigen opmaak, want ook de vormgeving vertelt iets over een tekst en leest prettiger dan een kaal tekstvenster.

Met één knop laat Deepdive rechts zien wat de auteur met dit stuk wil en hoe het betoog in elkaar zit: de samenvatting en de **blauwdruk**. Daardoor landt alles wat je daarna leest op zijn eigen plek.

Loop je ergens vast, dan selecteer je het stuk dat je niet snapt en vraag je het de professor. Die kent de hele tekst, dus de uitleg gaat over jouw stuk in zijn verband, en niet over een losse alinea.

### De app

```
┌───────────────────────────────┬──────────────────────┐
│  URL plakken of slepen · pdf  │  Model: [Lokaal ▾]   │
├───────────────────────────────┼──────────────────────┤
│                               │  [Maak blauwdruk]    │
│  Originele website of pdf     │                      │
│  met eigen layout en stijl    │  Doel en boodschap   │
│                               │  Samenvatting        │
│  Selecteren, markeren in      │  Levensloop-diagram  │
│  kleuren, vragen stellen      │  Aannames en gaten   │
│                               │  Antwoorden          │
└───────────────────────────────┴──────────────────────┘
```

- **Links** staat het originele stuk. Websites en pdf's werken op dezelfde manier: selecteren, markeren en vragen stellen.
- **Rechts** staat de professor, in een rustige eigen leesstijl.
- **Bovenaan** kies je het model: een dienst met API-sleutel, of een lokaal model op je eigen computer.

**Het doel is begrip, nu, terwijl je leest:** snappen wat er staat, waarom het er staat en of het klopt.

### Wat Deepdive niet is

Deepdive is geen leer- of toetstool. Er is geen overhoring, geen score, geen flashcards en geen lesmateriaal. Je gebruikt het niet om iets te stampen voor later, maar om een tekst te doorzien op het moment dat je hem leest.

## Voor wie

Iedereen die moeilijke of belangrijke teksten echt wil begrijpen en niet zomaar wil geloven. De eerste versie is voor jezelf: zonder accounts en zonder server, met je eigen sleutels of lokale modellen. Andere nieuwsgierige lezers komen later.

---

## Kernfuncties

### 1. De blauwdruk: het hele betoog in één oogopslag

Dit is het hart van Deepdive. Zodra je een stuk hebt geopend, vraag je met één knop de samenvatting en blauwdruk op, in het paneel rechts. Zo heb je het overzicht nog vóór je begint met lezen. De blauwdruk bestaat uit drie lagen.

#### Laag 1: het doel van het stuk

Eerst weet je in één oogopslag wat de auteur probeert te doen en wat je moet meenemen.

| Onderdeel | Vraag die het beantwoordt |
|---|---|
| **Doel** | Wat doet de auteur hier? Zie de lijst hieronder. |
| **De boodschap in één zin** | Wat wil de auteur dat ik meeneem? |
| **De aanleiding** | Waarom is dit geschreven? Wat klopt er niet of wat ontbreekt er? |

Voorbeelden van doelen:

- een probleem uitleggen
- een oplossing bieden voor een probleem
- een frustratie uiten
- een persoonlijke ervaring vertellen (memoire)
- een concept of idee uitwerken
- de lezer overtuigen van een standpunt
- een onderzoek en de resultaten rapporteren
- een gebeurtenis verslaan
- een bestaand idee of een andere auteur weerleggen

Een stuk kan meerdere doelen hebben. Dan noemt de blauwdruk het hoofddoel en de bijdoelen, bijvoorbeeld: "vertelt een persoonlijke ervaring om de lezer van een standpunt te overtuigen".

#### Laag 2: de levensloop van het betoog

Daarna zie je in een **diagram** hoe het stuk van begin tot eind is opgebouwd. Dit gaat verder dan inleiding, uitleg en conclusie: het laat zien welke stappen de auteur zet en welke stap op welke andere steunt.

```
 DOEL: de lezer overtuigen dat X moet veranderen

 ① Aanleiding            ¶1–2    Er gaat iets mis met X
        │
        ▼
 ② Begrippen             ¶3–5    Wat a, b en c betekenen
        │
        ▼
 ③ Hoe het werkt         ¶6–9    Hoe x, y en z samenhangen
        │
        ├─────────────┐
        ▼             ▼
 ④ Bewijs voor k      ⑤ Bewijs voor l    ¶10–15
        │             │
        └──────┬──────┘
               ▼  ⚠ sprong: bewijs gaat over A, conclusie over B
 ⑥ Conclusie m           ¶16–17  Daarom moet X veranderen
               │
               ▼
 ⑦ Bezwaar en antwoord   ¶18–19  "Critici zeggen..., maar..."
```

- **Elk blok** heeft een rol (aanleiding, begrip, uitleg, bewijs, voorbeeld, bezwaar, conclusie), een korte inhoud en de alinea's waar het staat.
- **Elke pijl** laat zien hoe de ene stap op de andere steunt: "om k te bewijzen heeft de auteur eerst x, y en z nodig".
- **De vorm past bij de tekst.** Een memoire is een verhaallijn met een les aan het eind. Een paper loopt van vraag via methode en resultaten naar interpretatie. Een opiniestuk loopt van stelling via argumenten naar weerlegging.

#### Laag 3: de kritische laag

Op hetzelfde diagram zie je waar het betoog zwak is. De meeste zwakke plekken zitten op de pijlen: daar gaat de auteur van het ene naar het andere.

| Onderdeel | Vraag die het beantwoordt |
|---|---|
| **Aannames** | Waar gaat de auteur van uit, ook als dat nergens staat? |
| **Sprongen** | Waar volgt de conclusie niet uit wat ervoor staat? |
| **Logische gaten** | Waar ontbreekt een stap, of spreekt de tekst zichzelf tegen? |
| **Bewijs** | Hoe sterk is het bewijs voor elke claim? Is het een onderzoek, een anekdote of alleen een bewering? |
| **Wat ontbreekt** | Welke tegenargumenten, alternatieve verklaringen of partijen blijven buiten beeld? |
| **Kop tegenover inhoud** | Gaan de kop of de samenvatting verder dan de tekst zelf? Cijfers uit een samenvatting worden gecontroleerd tegen de tabellen waar ze vandaan komen. |
| **Voorkennis** | Welke woorden en begrippen worden bekend verondersteld? |

De professor is hierin eerlijk over de grenzen van de analyse:

- **Wat er staat en wat de professor afleidt, blijft gescheiden.** Een niet-vermelde aanname is een interpretatie en wordt ook zo genoemd, met de alinea waarop die is gebaseerd en hoe zeker de professor is.
- **Er worden geen gebreken verzonnen.** Vindt de professor geen gat, dan zegt de blauwdruk dat. Een memoire hoeft ook niets te bewijzen; daar gaat het eerder om wat wordt weggelaten of om een les die verder gaat dan de ervaring.

#### Waar de kritische blik op let, per soort tekst

| Soort tekst | Wat de professor je helpt doorzien |
|---|---|
| **Krantenartikel** | Wat is feit en wat is duiding? Wie komt aan het woord en wie niet? Welke achtergrond moet je kennen? Gaat de kop verder dan het artikel? |
| **Opiniestuk** | Wat is de stelling en wat zijn de argumenten? Welke aannames blijven onuitgesproken? Wie is de auteur, en wat zou de tegenpartij zeggen? |
| **Onderzoekspaper** | Wat is onderzocht en hoe? Wat betekenen de methode en de statistiek? Hoe sterk is het bewijs en wat mag je er níet uit concluderen? |
| **Memoire of persoonlijk verhaal** | Wat is de les die de auteur eruit trekt? Wat is ervaring en wat is generalisatie? |

#### De blauwdruk leest met je mee

- **Snel zichtbaar:** na de klik op de knop verschijnen eerst doel en boodschap, daarna het diagram en als laatste de kritische laag.
- **"Je bent hier":** terwijl je scrollt en bij elke selectie licht het blok op waar je nu bent. Zo landt alles op zijn plek.
- **Altijd bij de hand:** de blauwdruk staat in het rechterpaneel, en klikken op een blok springt naar die plek in de tekst.
- **Eén keer maken:** de blauwdruk wordt bewaard bij de vaste kopie van de bron, dus je betaalt of wacht niet opnieuw als je het stuk later opent.
- **Herkomst zichtbaar:** bij elke blauwdruk staat welk model die heeft gemaakt.
- **Uitleg verwijst terug**, bijvoorbeeld: "Dit is het bezwaar uit stap 7" of "Hier zit de sprong uit stap 6".
- **Inzoomen:** het hele stuk, dit hoofdstuk, deze alinea.

### 2. Selecteren en vragen, op websites en pdf's

```
tekst selecteren in het linkerpaneel
  of een kader trekken om een grafiek, tabel of formule
  → menu naast de selectie:

  💡 Leg uit        🧒 Jip & Janneke     ❓ Wat bedoelt de auteur?
  🧩 Waar past dit in het betoog?        🔎 Volgt dit echt?
  ✏️ Teken het      [ eigen vraag... ]
  → antwoord in het rechterpaneel, doorvragen kan
```

Het kader is ook de terugvaloptie als selecteren niet goed werkt, zoals in een gescande pdf of bij tekst in twee kolommen.

### 3. Het selectiemenu

De drie meest gebruikte acties staan direct in beeld, de rest zit onder **⋯**. Je kunt ook gewoon beginnen met typen terwijl iets geselecteerd is.

| Actie | Wat het doet |
|---|---|
| **Vraag stellen** | Eigen vraag, door te typen |
| **Leg uit** | Wat het hier betekent én waarom het op deze plek staat; wie of wat een naam is; beeldspraak uitgelegd |
| **Waar past dit in het betoog?** | Welke stap van de blauwdruk dit is en wat dit stuk daarin doet |
| **Volgt dit echt?** | Welke aannames hier onder zitten en of de conclusie volgt uit wat ervoor staat |
| **Wat is het bewijs?** | Wat de auteur hiervoor aanvoert en hoe sterk dat is |
| **Jip & Janneke** | Eenvoudige taal, zonder vakjargon |
| **Eenvoudiger** | Hetzelfde idee in gewone woorden, plus één regel over het punt dat het maakt |
| **Wat bedoelt de auteur?** | De bedoeling achter een zin, inclusief ironie of wat er tussen de regels staat |
| **Wat betekent dit woord?** | Het woord zoals déze auteur het gebruikt; of het ouderwets of vaktaal is |
| **Geef voorbeelden** | Concreet en herkenbaar |
| **Teken het** | Diagram, tijdlijn, schema of begrippenkaart (SVG of Mermaid) |
| **Klopt dit nog?** | Zoekt op het web: wat klopt nog, wat is veranderd, hoe zeker is dat |
| **Waar komt dit nog terug?** | Waar de tekst dit idee verder uitwerkt, met alineanummers |
| **Tegenargument** | Het sterkste bezwaar, en hoe de auteur zou antwoorden |
| **Citaat kopiëren** | Met titel en alineanummer |
| **Markeren** | In 4 kleuren |
| **Notitie** | In je eigen woorden, bij de markering |

**Het menu past zich aan de selectie aan:**

| Selectie | Voorgestelde acties en vragen |
|---|---|
| Woord of korte zinsdeel (≤ 4 woorden) | Wat betekent dit woord? · "Waarom dit woord hier?" · "Waar komt het vandaan?" |
| Passage | Waar past dit in het betoog? · Eenvoudiger / Jip & Janneke · "Volgt dit echt?" · "Wat is het bewijs?" |
| Grafiek of tabel | "Lees deze grafiek voor me" · "Wat is de conclusie?" · "Laat dit zien wat de auteur zegt?" |
| Formule | "Leg stap voor stap uit" · "Wat betekent elk symbool?" |
| Afbeelding | "Wat zie ik hier?" |
| Andere taal | "Vertaal en leg uit" |

### 4. Hoe antwoorden eruitzien

- **De kern voorop en gemarkeerd**, zodat je in één oogopslag het antwoord ziet.
- **Verwijzingen naar alinea's** (¶12): klikken springt naar die plek.
- **"Volgens de tekst" en "buiten de tekst" gescheiden**: de professor zegt het als er kennis van buiten het stuk bij komt.
- **Lengte instelbaar**: kort, normaal, uitgebreid.
- **Schakelaar "Web"** aan of uit, met bronnen als [1], [2].
- **Lange antwoorden klappen in** tot vijf regels.

### 5. De professor denkt mee

De professor beantwoordt niet alleen vragen, maar denkt ook met je mee, zoals in een goed gesprek:
- "Wat denk je dat de auteur hiermee wil zeggen?"
- "Let op: hier verandert het onderwerp van A naar B."
- "Dit lijkt op wat de auteur in ¶4 beweerde, maar het is sterker geformuleerd."

Dit is altijd optioneel en bedoeld om het stuk beter te begrijpen. Er komt geen score en niets komt later terug om te herhalen.

### 6. Tijdens het lezen

- **Minikaart in de zijlijn**: de hele tekst als streepjes, met markeringen, antwoorden en de blokken van de blauwdruk. Klik om te springen.
- **Alineanummers** in de kantlijn.
- **Rustige stand**: dezelfde pagina met dezelfde stijl en afbeeldingen, maar zonder advertenties, cookiebalken, zijkolommen en "lees ook"-blokken. De pagina wordt dus niet omgezet naar een kaal tekstvenster, en het origineel is altijd één toets verder.
- **Voorlezen** vanaf waar je bent, met de alinea die gelezen wordt gemarkeerd.
- **Vragen over de hele tekst** vanaf je leespositie ("ik ben nu bij ¶12").
- **Sneltoetsen**: `/` vraag over de hele tekst · `J`/`K` volgende of vorige alinea · `Enter` vraag over de huidige alinea · `B` blauwdruk · `N` notitieboek · `F` rustige stand · `[` `]` vorig of volgend antwoord · `Esc` terug · `?` overzicht.

### 7. Notitieboek

Al je vragen, antwoorden, markeringen en notities, in de volgorde van de tekst, om later terug te kunnen vinden wat je hebt uitgezocht. Te exporteren als Markdown, ook als zip die je direct in Obsidian kunt zetten.

---

## Context: de app moet het hele stuk kennen

Een blauwdruk van een half artikel is weinig waard. Deepdive haalt daarom per soort bron het hele stuk op:

| Bron | Hoe Deepdive het hele stuk kent |
|---|---|
| Website | Je plakt of sleept de URL. De app laadt de pagina in een verborgen webview en slaat de volledig opgebouwde pagina op. |
| PDF | Je sleept het bestand in de app of opent een pdf-link. De app leest alle bladzijden en toont de echte pagina's. |
| Geplakte tekst | De reserve als een site het ophalen blokkeert. |
| Stencil of boek | Een reeks foto's ("bladzijde 1 t/m 4") wordt één bron, bijvoorbeeld vanaf je telefoon via een QR-code. |
| Lastige pdf | Staan kolommen, tabellen of formules door elkaar, dan kun je de pdf "zorgvuldiger laten lezen" met een beter model. |

Geselecteerde tekst gaat als tekst naar de professor en een kader als afbeelding. De volledige bron gaat mee als context. Past de bron niet in het gekozen model, dan meldt de app dat en laat die niet stilletjes een deel weg.

### De vaste kopie

Elke bron wordt bij het openen vastgelegd, zodat die niet meer verandert. Je leest in deze kopie, dus niet op de live site.

- **Tekstkopie:** de volledige tekst in blokken met vaste alineanummers. Daarop steunen de blauwdruk, de ¶-verwijzingen en het zoeken.
- **Visuele kopie:** de pagina met HTML, CSS en afbeeldingen, zonder scripts. Daarin lees je en daarop staan je markeringen.
- **Wijzigingen zien:** open je een bron opnieuw, dan kan Deepdive de live tekst vergelijken met de kopie en melden: "Dit artikel is gewijzigd sinds je het las."

**Beperkingen:** video's en interactieve grafieken werken in de kopie vaak niet meer, en sommige sites blokkeren het ophalen. Kopieën kunnen ook persoonlijke gegevens bevatten als je bent ingelogd; ze blijven daarom lokaal.

**Betaalmuren:** je browserlogin werkt niet in de app. Je kunt wel in een venster in de app inloggen, zodat de app die sessie onthoudt.

---

## Modellen: kies zelf je provider

Deepdive zit niet vast aan één AI-dienst. Dit is een kernonderdeel van de app.

- **Providers aanmaken:** bijvoorbeeld Anthropic, OpenAI of OpenRouter, en lokaal Ollama of LM Studio. Per provider stel je het adres en de API-sleutel in, en daarbij kies je de modellen.
- **Model per actie:** bijvoorbeeld een sterk model voor de blauwdruk en een snel of lokaal model voor korte uitleg. Bovenaan het rechterpaneel kun je altijd wisselen.
- **Mogelijkheden per model:** de app houdt bij of een model afbeeldingen kan lezen en hoeveel tekst het aankan. Een actie die een model niet kan uitvoeren, wordt duidelijk gemeld.
- **Veilige opslag:** API-sleutels staan in de sleutelhanger van het besturingssysteem, niet in een los configuratiebestand.

---

## Projecten: één Deepdive per onderwerp

Alles over één onderwerp blijft bij elkaar in een project.

```
📁 Deepdive: "Klimaatakkoord van Parijs"
 ├─ 📄 Bronnen        artikel (link + tekst), pdf, foto's van een stencil
 ├─ 🗺️ Blauwdrukken     per bron, plus hoe de bronnen zich tot elkaar verhouden
 ├─ 🔍 Uitdiepingen   elk kader: uitsnede, vraag, antwoord, plek in de blauwdruk
 ├─ ✏️ Diagrammen     alles wat de professor heeft getekend
 └─ 📝 Notities       eigen aantekeningen
```

- Een project kan **meerdere bronnen** hebben. De professor legt verbanden tussen bronnen ("dit zegt het artikel ook, maar anders").
- Projecten worden **lokaal** opgeslagen als map of bestand, zonder dat je een server nodig hebt.
- **Automatisch indelen**: bij een nieuwe bron stelt Deepdive voor bij welk project die hoort, met onderwerp en tags. Zelf verplaatsen gaat altijd voor.
- **Koppeling met andere AI** (MCP): Claude of een andere assistent kan bronnen aan een project toevoegen en erin zoeken.

### Delen

| Manier | Wat de ander krijgt | Handig voor |
|---|---|---|
| Projectbestand (`.deepdive`) | Alles, en de ander kan in Deepdive zelf verder vragen en verdiepen | Samen een stuk uitpluizen |
| Export | PDF of Markdown van de blauwdruk en je uitdiepingen | Doorsturen, bewaren, printen |

**Auteursrecht:** bij delen gaan van webartikelen standaard alleen de link en de citaten mee, niet de volledige tekst. Bij eigen pdf's en foto's kiest de gebruiker.

---

## Techniek

Eerst alleen **macOS**: daar wordt alles gebouwd en getest. Windows volgt als alle functies naar wens werken.

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Desktop-app | **Tauri 2** (Rust + web-UI in TypeScript) | Eén codebase voor beide OS'en, klein (±10 MB) en snel |
| Browser-engine | De systeem-webview via Tauri: WebKit op macOS, WebView2 op Windows | Houdt de app klein en wordt door het OS bijgewerkt |
| Pagina's ophalen | Verborgen webview, daarna de opgebouwde pagina opslaan zonder scripts | Werkt ook bij sites die hun inhoud met JavaScript opbouwen |
| Pdf's | pdf.js in het linkerpaneel | Echte pagina's met een selecteerbare tekstlaag |
| AI | Eigen laag voor meerdere providers, aangeroepen vanuit Rust, met beeld en streaming | Vrije keuze van model, ook lokaal; sleutels blijven buiten de webview |
| API-sleutels | Sleutelhanger van het OS | Niet leesbaar in configuratiebestanden |
| Blauwdruk | Gestructureerde data met een eigen weergave | Blokken zijn klikbaar en kunnen oplichten, en gaten kunnen op de pijlen staan |
| Overige diagrammen | SVG en Mermaid, gerenderd in het paneel | Uitlegschema's bij antwoorden |
| Opslag | Lokaal: projectmap of `.deepdive` (zip met JSON, afbeeldingen en bronnen) | Geen server nodig, makkelijk te delen |

Aandachtspunten:
- **Engine vervangbaar houden:** het laden en opslaan van pagina's wordt een afgebakend onderdeel. Blijkt de systeem-webview te wisselvallig, dan is Chromium via CEF de logische volgende stap, zodra die koppeling voor Tauri stabiel is. Dat maakt de app wel fors groter. Andere kleine engines, zoals Servo, zijn nu nog niet betrouwbaar genoeg.
- **Verschillen tussen OS'en:** WebKit en WebView2 gedragen zich niet altijd hetzelfde. Daarom wordt alles opnieuw getest zodra de Windows-stap begint.
- **Veiligheid:** een pagina van internet is onbetrouwbare inhoud. De pagina draait afgeschermd en kan niet bij de sleutels komen. Tekst op een pagina wordt behandeld als bron en niet als instructie aan het model.
- **Kwaliteit per model:** de blauwdruk moet worden getest op verschillende soorten teksten en modellen, ook lokale modellen.
- **Stijl:** het rechterpaneel krijgt het gevoel van Gloss, met een warme papierkleur, rustige serif en veel witruimte. We maken deze stijl zelf, omdat de Gloss-repo geen licentie heeft.

---

## Volgorde van bouwen

**Eerste versie:**

1. **Bronnen openen**: URL of pdf plakken of slepen, tonen in het linkerpaneel en vastleggen als vaste kopie. Vroeg testen op 20 echte sites op macOS.
2. **Providers en modellen**: providers aanmaken, sleutels veilig opslaan en lokale modellen koppelen.
3. **Blauwdruk**: de knop, de samenvatting, het doel, de levensloop en de kritische laag in het rechterpaneel.
4. **Selecteren en vragen**: selecteren, kader, selectiemenu, markeren, antwoorden, "je bent hier" en terugverwijzen.

**Daarna:**

5. **Projecten**: lokaal bij elkaar houden van bronnen, uitdiepingen, markeringen en het notitieboek.
6. **Prettiger lezen**: rustige stand, minikaart, alineanummers, voorlezen, sneltoetsen, foto's en fotoreeks vanaf de telefoon.
7. **De professor denkt mee**: meedenkvragen en signalen tijdens het lezen.
8. **Delen**: `.deepdive`-bestand en export (ook Markdown/Obsidian).
9. **Koppelingen**: automatisch indelen, MCP-koppeling met andere AI.
10. **Windows**: de app werkend maken en testen op Windows, als al het bovenstaande naar wens werkt.

**Bewust niet in dit plan:** een browserextensie en een kader over andere apps, zoals Word of Kindle. Ook lezen op de telefoon valt hier voorlopig buiten.

## Referentie: Gloss

[Gloss](https://github.com/Nutlope/gloss) is een open-source web-app waarin je artikelen en pdf's leest en bij een selectie antwoorden in de kantlijn krijgt. Het selectiemenu, de antwoordstijl, de kanttekeningen in de blauwdruk, de minikaart en het notitieboek hierboven zijn op Gloss geïnspireerd.

**Het verschil:** Gloss zet elke tekst om naar zijn eigen uniforme lezer en draait als web-app. Deepdive behoudt de originele opmaak, laat de blauwdruk van het hele betoog zien, werkt lokaal op je eigen computer en laat je zelf je model kiezen, ook een lokaal model.

Uitproberen kan op de demosite: [gloss-lovat.vercel.app](https://gloss-lovat.vercel.app).

De Gloss-repo heeft **geen licentie**, dus we nemen ideeën over en geen code.

## Open vragen

- Moet een project automatisch starten bij een nieuwe bron, of kies je zelf "Nieuwe deepdive"?
- Hoe vaak mag de professor uit zichzelf meedenken? Instelbaar per project?
- Taal: altijd Nederlands, of in de taal van de bron?

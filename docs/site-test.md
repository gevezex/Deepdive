# Site-test bronnen openen

Getest op 5 november 2026 op macOS 27.0.1 met WebKit, in de debug-build met de testhaak. De adressen staan in [site-test-urls.txt](site-test-urls.txt) en zijn dezelfde dag uit de rss-feeds van de sites gehaald.

**Windows is niet getest.** Op deze Mac kan dat niet. De code heeft wel een aparte tak voor WebView2, maar die is nooit uitgevoerd. VISIE.md vraagt om een test op beide systemen, dus dat staat nog open.

## Uitslag

Van de 22 sites gaven er 15 het hele stuk, 6 een deel en 1 geen kopie.

- **Betaalmuren zijn de grootste beperking.** Vooral Nederlandse kranten leveren zonder abonnement alleen de intro. Inloggen in een venster in de app (zie VISIE.md) is nog niet gebouwd.
- **Wat "Volledig" hier betekent:** het aantal woorden is plausibel, de laatste alinea lijkt het echte einde en de schermafdruk klopt. De tekst is niet regel voor regel vergeleken met de originele site.
- **Pagina-opbouw met JavaScript werkt.** Docsify bouwt de hele pagina in de browser op, en ook de React- en Next.js-sites geven tekst.

## Per site

Blokken zijn de alinea's in de tekstkopie. Bestanden zijn afbeeldingen, CSS en fonts: opgeslagen / mislukt. De tijd is die van het ophalen en opslaan. Bij pdf's komt het lezen van de tekst daar nog bij.

| Site | Domein | Resultaat | Tijd | Blokken | Woorden | Bestanden | Opmerkingen |
|---|---|---|---|---:|---:|---:|---|
| krant-nos | nos.nl | Volledig | 10 s | 20 | 481 | 22 / 0 | Foto en opmaak kloppen. Cookiemelding is uit de kopie. |
| krant-nrc | nrc.nl | Deels, wisselend | 4 s | 7 | 80 | 96 / 0 | In deze ronde alleen de intro. In een eerdere ronde kwamen er 997 woorden binnen, dus de site levert niet altijd hetzelfde. |
| krant-volkskrant | volkskrant.nl | Deels (betaalmuur) | 10 s | 9 | 66 | 99 / 1 | Intro plus abonnementsblok. In de eerste ronde kwam alleen de cookiemuur binnen en gaf de app een foutmelding. |
| krant-trouw | trouw.nl | Deels (betaalmuur) | 11 s | 7 | 33 | 116 / 1 | Alleen de kop en het abonnementsblok. De app waarschuwt voor een mogelijk onvolledig stuk. |
| krant-bbc | bbc.co.uk | Volledig | 15 s | 51 | 975 | 30 / 1 | Tekst en opmaak goed. Onder de kop staat een groot grijs vlak waar vermoedelijk de hoofdafbeelding of video hoort; de oorzaak is niet onderzocht. |
| krant-nyt | nytimes.com | Geblokkeerd | 9 s | – | – | – | Fout 403. Er wordt niets opgeslagen en de melding biedt "Tekst plakken" aan. |
| opinie-guardian | theguardian.com | Volledig | 4 s | 18 | 1097 | 52 / 0 | Opmaak goed. Bovenaan staat een leeg advertentievlak. |
| opinie-aeon | aeon.co | Volledig | 22 s | 45 | 3289 | 21 / 0 | Opmaak goed. De zwevende donatievraag is uit de kopie. |
| nieuws-tweakers | tweakers.net | Volledig | 5 s | 5 | 205 | 142 / 13 | Kort nieuwsbericht, reacties tellen niet mee in de tekstkopie. De mislukte bestanden zijn vooral avatars bij reacties. |
| blog-substack | astralcodexten.com | Volledig | 30 s | 119 | 6041 | 42 / 0 | Lange tekst, opmaak goed. |
| blog-simonwillison | simonwillison.net | Volledig | 4 s | 16 | 209 | 10 / 0 | Heel kort bericht, dus de waarschuwing is hier onterecht. De tekstkopie bevat ook de zijkolom en voettekst. |
| blog-paulgraham | paulgraham.com | Volledig | 38 s | 235 | 11883 | 4 / 0 | Oude opmaak met tabellen en dubbele regeleindes, netjes gesplitst in alinea's. |
| blog-medium | medium.com | Deels (betaalmuur) | 14 s | 10 | 183 | 76 / 0 | Verhaal alleen voor leden: de tekst stopt midden in een zin. De app waarschuwt. |
| blog-devto | dev.to | Volledig | 15 s | 55 | 1314 | 22 / 0 | React-site. Codeblokken en opmaak goed, zwevende reclame is uit de kopie. |
| wetenschap-quanta | quantamagazine.org | Volledig | 29 s | 122 | 2510 | 54 / 1 | Opmaak en afbeeldingen goed, één font ontbreekt. |
| wetenschap-plos | journals.plos.org | Volledig | 34 s | 318 | 7064 | 84 / 37 | Hele artikel met bronnen. Zwevende navigatie overlapt bovenaan de kop, omdat de scripts die haar plaatsen weg zijn. De mislukte bestanden zijn onder meer tijdschriftlogo's. |
| wetenschap-plos-pdf | journals.plos.org | Volledig | 1 s | 324 | 8073 | – | Echte pagina's met tekstlaag. De zijkolom staat vooraan in de tekstkopie: de leesvolgorde is niet overal hetzelfde als op de pagina. |
| wetenschap-arxiv-pdf | arxiv.org | Volledig | 0 s | 211 | 5682 | – | Echte pagina's met tekstlaag. |
| wetenschap-nature | nature.com | Deels (betaalmuur) | 11 s | 47 | 234 | 29 / 0 | Alleen kop en intro, plus de pagina eromheen. Cookielaag is uit de kopie. |
| js-verge | theverge.com | Deels (betaalmuur) | 9 s | 6 | 274 | 159 / 0 | Next.js-site. Eerdere ronden toonden een abonnementsvraag. Geen waarschuwing, want het blijft net boven de grens van 250 woorden. Een kleine voorwaardenbalk blijft onderin staan. |
| js-docsify | docsify.js.org | Volledig | 10 s | 32 | 475 | 33 / 0 | Pagina wordt helemaal in de browser opgebouwd. Tekst en opmaak goed; de tekstkopie bevat ook het zijmenu. |
| referentie-wikipedia | nl.wikipedia.org | Volledig | 16 s | 80 | 2058 | 138 / 0 | Opmaak en infobox goed. |

## Hoe er is getest

- **Ophalen:** de echte app haalde elk adres op via de testhaak, in verborgen vensters.
- **Tonen:** elke kopie is in het linkerpaneel geopend en met een schermafdruk van het hoofdvenster bekeken.
- **Offline kopieën:** de opgeslagen kopieën van de echte sites bevatten geen verwijzingen meer naar internet in afbeeldingen, stijlen of fonts, en ook geen scripts. Na een herstart zijn alleen de testkopieën opnieuw geopend, met de testserver uit. Het netwerk van de Mac zelf is niet uitgezet.
- **Aanvalspagina:** een eigen testpagina probeerde scripts, handlers, beacons, formulieren en een aanroep van de app-commando's. Het verborgen venster kreeg die commando's niet (geweigerd). Het openen van de opgeslagen kopie gaf nul verzoeken aan de testserver.
- **Invoer in de app:** URL in het veld, pdf-link, onbereikbare site met foutmelding, geplakte tekst en hetzelfde adres nog eens openen (geen tweede kopie) zijn in de echte app doorlopen, net als herstart met de testserver uit.
- **Release-build:** `Deepdive.app` (18 MB) is gebouwd en start, maar de bovenstaande tests zijn op de debug-build gedaan.

## Niet getest

- **Windows**, zie boven.
- **Echt slepen vanuit Finder of een browser.** Alleen nagebootste sleepacties zijn getest, ook die op de kopie zelf.
- **De knop "Pdf kiezen"**, omdat die een dialoog van het systeem opent.
- **Plakken met Cmd+V buiten het invoerveld.**
- **Tekenen van pdf-pagina's in een onzichtbaar venster:** dat staat stil tot het venster weer zichtbaar is. De tekstlaag en tekstkopie werken dan wel. Bij een zichtbaar venster zijn de pagina's goed getekend.

## Bekende beperkingen

- De uitslag per site kan per keer verschillen (zie NRC en Volkskrant), omdat sites varianten en cookie- en betaalmuren per bezoek anders tonen.
- Cookielagen en grote zwevende vlakken worden herkend met vuistregels, dus er kan iets blijven staan of onterecht verdwijnen. De app klikt nooit iets aan.
- De tekstkopie kan menu's of bijschriften bevatten, omdat de app bij twijfel liever te veel dan te weinig meeneemt.
- Ingesloten video's en grafieken worden een plaatsaanduiding met een link. Zwevende widgets vervallen.
- Afbeeldingen, CSS en fonts worden zonder de cookies van de site opgehaald, dus bestanden achter een login kunnen ontbreken.

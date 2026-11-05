# Site-test bronnen openen

Getest op 5 november 2026 op macOS 27.0.1 met WebKit, in de debug-build met de testhaak. De adressen staan in [site-test-urls.txt](site-test-urls.txt) en zijn dezelfde dag uit de rss-feeds van de sites gehaald.

**Windows is niet getest.** Op deze Mac kan dat niet. De code heeft wel een aparte tak voor WebView2, maar die is nooit uitgevoerd. Dat is een bewuste keuze: Windows komt pas als alle functies op macOS naar wens werken (zie VISIE.md).

## Uitslag

Van de 22 sites gaven er 15 het hele stuk, 6 een deel en 1 geen kopie.

- **Betaalmuren zijn de grootste beperking.** Vooral Nederlandse kranten leveren zonder abonnement alleen de intro. De app herkent dat nu en biedt aan om in te loggen (zie "Oordeel over de volledigheid").
- **Wat "Volledig" hier betekent:** het aantal woorden is plausibel, de laatste alinea lijkt het echte einde en de schermafdruk klopt. De tekst is niet regel voor regel vergeleken met de originele site.
- **Pagina-opbouw met JavaScript werkt.** Docsify bouwt de hele pagina in de browser op, en ook de React- en Next.js-sites geven tekst.

## Per site

Blokken zijn de alinea's in de tekstkopie. Bestanden zijn afbeeldingen, CSS en fonts: opgeslagen / mislukt. De tijd is die van het ophalen en opslaan. Bij pdf's komt het lezen van de tekst daar nog bij.

| Site | Domein | Resultaat | Tijd | Blokken | Woorden | Bestanden | Opmerkingen |
|---|---|---|---|---:|---:|---:|---|
| krant-nos | nos.nl | Volledig | 10 s | 20 | 481 | 22 / 0 | Foto en opmaak kloppen. Cookiemelding is uit de kopie. |
| krant-nrc | nrc.nl | Deels, wisselend | 4 s | 7 | 80 | 96 / 0 | In deze ronde alleen de intro. In een eerdere ronde kwamen er 997 woorden binnen, dus de site levert niet altijd hetzelfde. |
| krant-volkskrant | volkskrant.nl | Deels (betaalmuur) | 10 s | 9 | 66 | 99 / 1 | Intro plus abonnementsblok. In de eerste ronde kwam alleen de cookiemuur binnen en gaf de app een foutmelding. |
| krant-trouw | trouw.nl | Deels (betaalmuur) | 11 s | 7 | 33 | 116 / 1 | Alleen de kop en het abonnementsblok. Wordt herkend. |
| krant-bbc | bbc.co.uk | Volledig | 15 s | 51 | 975 | 30 / 1 | Tekst en opmaak goed. Onder de kop staat een groot grijs vlak waar vermoedelijk de hoofdafbeelding of video hoort; de oorzaak is niet onderzocht. |
| krant-nyt | nytimes.com | Geblokkeerd | 9 s | – | – | – | Fout 403. Er wordt niets opgeslagen en de melding biedt "Tekst plakken" aan. |
| opinie-guardian | theguardian.com | Volledig | 4 s | 18 | 1097 | 52 / 0 | Opmaak goed. Bovenaan staat een leeg advertentievlak. |
| opinie-aeon | aeon.co | Volledig | 22 s | 45 | 3289 | 21 / 0 | Opmaak goed. De zwevende donatievraag is uit de kopie. |
| nieuws-tweakers | tweakers.net | Volledig | 5 s | 5 | 205 | 142 / 13 | Kort nieuwsbericht, reacties tellen niet mee in de tekstkopie. De mislukte bestanden zijn vooral avatars bij reacties. |
| blog-substack | astralcodexten.com | Volledig | 30 s | 119 | 6041 | 42 / 0 | Lange tekst, opmaak goed. |
| blog-simonwillison | simonwillison.net | Volledig | 4 s | 16 | 209 | 10 / 0 | Heel kort bericht, en het krijgt terecht geen waarschuwing meer. De tekstkopie bevat ook de zijkolom en voettekst. |
| blog-paulgraham | paulgraham.com | Volledig | 38 s | 235 | 11883 | 4 / 0 | Oude opmaak met tabellen en dubbele regeleindes, netjes gesplitst in alinea's. |
| blog-medium | medium.com | Deels (betaalmuur) | 14 s | 10 | 183 | 76 / 0 | Verhaal alleen voor leden: de tekst stopt midden in een zin. Wordt herkend. |
| blog-devto | dev.to | Volledig | 15 s | 55 | 1314 | 22 / 0 | React-site. Codeblokken en opmaak goed, zwevende reclame is uit de kopie. |
| wetenschap-quanta | quantamagazine.org | Volledig | 29 s | 122 | 2510 | 54 / 1 | Opmaak en afbeeldingen goed, één font ontbreekt. |
| wetenschap-plos | journals.plos.org | Volledig | 34 s | 318 | 7064 | 84 / 37 | Hele artikel met bronnen. Zwevende navigatie overlapt bovenaan de kop, omdat de scripts die haar plaatsen weg zijn. De mislukte bestanden zijn onder meer tijdschriftlogo's. |
| wetenschap-plos-pdf | journals.plos.org | Volledig | 1 s | 324 | 8073 | – | Echte pagina's met tekstlaag. De zijkolom staat vooraan in de tekstkopie: de leesvolgorde is niet overal hetzelfde als op de pagina. |
| wetenschap-arxiv-pdf | arxiv.org | Volledig | 0 s | 211 | 5682 | – | Echte pagina's met tekstlaag. |
| wetenschap-nature | nature.com | Deels (betaalmuur) | 11 s | 47 | 234 | 29 / 0 | Alleen kop en intro, plus de pagina eromheen. Cookielaag is uit de kopie. |
| js-verge | theverge.com | Deels (betaalmuur) | 9 s | 6 | 274 | 159 / 0 | Next.js-site. De pagina vraagt om een abonnement en wordt nu herkend. Een kleine voorwaardenbalk blijft onderin staan. |
| js-docsify | docsify.js.org | Volledig | 10 s | 32 | 475 | 33 / 0 | Pagina wordt helemaal in de browser opgebouwd. Tekst en opmaak goed; de tekstkopie bevat ook het zijmenu. |
| referentie-wikipedia | nl.wikipedia.org | Volledig | 16 s | 80 | 2058 | 138 / 0 | Opmaak en infobox goed. |

## Oordeel over de volledigheid

De grens op woordenaantal is weg. Elke webkopie krijgt een oordeel (`volledig`, `waarschijnlijk onvolledig` of `onbekend`) met een reden, opgeslagen als `completeness` in `source.json`. Het oordeel weegt:

- teksten als "Log in om verder te lezen", alleen als ze zwevend, na het stuk of aan het einde ervan staan, dus niet in menu's of voetteksten
- blokken met een naam als `paywall` die echt zichtbaar zijn
- gestructureerde paginadata: `isAccessibleForFree`, `wordCount` en `articleBody`, vergeleken met de gevonden tekst
- een zichtbaar wachtwoordveld, of een doorverwijzing naar een inlogpagina
- afgekapte of vervagende tekst, en tekst die midden in een zin of met puntjes stopt
- het aandeel van het stuk op de pagina, en de lengte van het stuk als tegenbewijs

Alleen `waarschijnlijk onvolledig` geeft een melding. Pdf's zijn `volledig` (het hele bestand is opgeslagen), geplakte tekst is `onbekend`.

Getest zonder in te loggen op 5 november 2026. De waarheid per site komt uit de tabel hierboven, en is dus niet regel voor regel vergeleken met het origineel.

| Lijst | Sites | Goed | Fout | Toelichting |
|---|---:|---:|---:|---|
| Bekende sites | 22 | 22 | 0 | 6 betaalmuren herkend (NRC, Volkskrant, Trouw, Medium, Nature, The Verge). 14 volledige stukken zonder waarschuwing, plus Tweakers als `onbekend`, ook zonder waarschuwing. NYT blijft geblokkeerd zonder kopie. |
| Controlelijst | 11 | 11 | 0 | [site-test-urls-controle.txt](site-test-urls-controle.txt). 3 betaalmuren herkend (FT, The Economist, De Groene). 8 stukken zonder waarschuwing (Wired, AD, Parool, NU.nl, Ars Technica, LWN, The New Yorker, Smashing). |

**Lees deze cijfers met de volgende kanttekeningen:**

- De regels zijn afgesteld op de 22 bekende sites. In de eerste ronde was The Verge fout: de gestructureerde data van die site bevat alleen het begin van het stuk, en dat leek een bevestiging dat het stuk compleet was. Die 22 goed zijn dus geen onafhankelijke meting.
- De controlelijst is onafhankelijker, maar klein. Eén regel is daarna toch aangepast: FT en The Economist weigeren het losse verzoek van de app met een foutcode en kregen daardoor de melding "geblokkeerd" in plaats van "onvolledig". Bij de 8 stukken zonder waarschuwing is alleen gekeken naar de lengte en het einde van de tekst.
- Sites leveren niet altijd hetzelfde. De Volkskrant gaf in de ene ronde een cookiemuur (foutmelding met de keuze om in te loggen) en in de andere een betaalmuur (herkend).
- De signalen van deze sites, zonder de artikeltekst, staan als regressietest in `src-tauri/src/completeness_cases.json`.

## Inloggen op sites

**Zelf testen op echte kranten (de app logt nooit voor je in):**

1. Open een betaald artikel. Bovenaan verschijnt "Dit stuk is waarschijnlijk onvolledig".
2. Kies **Inloggen** en log in het venster in bij de site zelf. De titelbalk toont op welk domein je nu bent.
3. Sluit het venster en kies **Opnieuw ophalen**. De nieuwe kopie hoort het hele stuk te bevatten, en de vorige blijft bereikbaar via "Vorige kopie".
4. Controleer het einde van de tekst met de site in je browser. Klopt het oordeel niet, dan horen we graag welke site het was.
5. Kies daarna **Sites** > **Uitloggen en wissen**, en haal het stuk nog eens op: de betaalmuur moet terug zijn.

**Hoe het werkt:**

- **Eigen opslag per site.** Elke site krijgt een eigen WebKit-opslag (macOS 14 of nieuwer). Pagina's van andere sites draaien daar nooit in en kunnen de sessie dus niet gebruiken, ook niet via verzoeken naar die site. Uitloggen verwijdert de hele opslag, inclusief cookies van inlogdiensten op een ander domein.
- **Wachtwoorden.** In het inlogvenster draait geen script van de app. De app kan een wachtwoord dus niet zien, bewaren of invullen. Op schijf staan alleen de sitenaam, een opslag-id en datums.
- **Afbeeldingen en stijlen achter een login komen mee.** Elk bestand wordt eerst zonder cookies gevraagd. Mislukt dat en staat het op dezelfde site als de pagina, dan volgt een tweede poging met de sessiecookies. Die cookies leest de app daarvoor kort uit de webview. Ze blijven in het geheugen, gaan alleen naar die site volgens de browserregels voor domein, pad en `Secure`, en verdwijnen bij een doorverwijzing naar een andere host of poort.
- **Opnieuw ophalen.** Dit maakt altijd een nieuwe bron met eigen alineanummers, en de oude kopie blijft onaangeroerd staan. Lijkt de nieuwe kopie slechter (bijvoorbeeld door een verlopen sessie), dan blijft de oude de bron en kiest de lezer zelf.
- **Kopie van een ingelogde pagina.** Scripts staan er niet in en kunnen er ook niet draaien (afgeschermde iframe plus CSP). Wachtwoordvelden en verborgen formuliervelden, waar inlogtokens in kunnen staan, zijn verwijderd. Andere persoonsgegevens op de pagina, zoals je naam, kunnen in de kopie staan. Die blijft lokaal.
- **Geen omzeiling.** De app klikt niets aan en haalt een zwevende betaalmuur niet meer weg uit de kopie.

**Veiligheid, nagelopen met `tests/e2e/login.e2e.mjs`:** de aanvalspagina is opnieuw gebruikt in het inlogvenster en in het verborgen venster. App-commando's werden in beide geweigerd, ook met het echte id van een kopie in de hand. Het schema van de kopieën antwoordt nu alleen nog aan het hoofdvenster; daarvoor kon een pagina in een ander venster een kopie opvragen als ze het id kende. Het openen van de opgeslagen aanvalspagina gaf nul verzoeken aan de testserver.

## Hoe er is getest

- **Ophalen:** de echte app haalde elk adres op via de testhaak, in verborgen vensters.
- **Tonen:** elke kopie is in het linkerpaneel geopend en met een schermafdruk van het hoofdvenster bekeken.
- **Offline kopieën:** de opgeslagen kopieën van de echte sites bevatten geen verwijzingen meer naar internet in afbeeldingen, stijlen of fonts, en ook geen scripts. Na een herstart zijn alleen de testkopieën opnieuw geopend, met de testserver uit. Het netwerk van de Mac zelf is niet uitgezet.
- **Aanvalspagina:** een eigen testpagina probeerde scripts, handlers, beacons, formulieren en een aanroep van de app-commando's. Het verborgen venster kreeg die commando's niet (geweigerd). Het openen van de opgeslagen kopie gaf nul verzoeken aan de testserver.
- **Invoer in de app:** URL in het veld, pdf-link, onbereikbare site met foutmelding, geplakte tekst en hetzelfde adres nog eens openen (geen tweede kopie) zijn in de echte app doorlopen, net als herstart met de testserver uit.
- **Inloggen:** `tests/e2e/login.e2e.mjs` draait de echte app tegen de lokale testsite `tests/e2e/mock-site.mjs`, met een willekeurig testwachtwoord. De test speelt daar de gebruiker. Doorlopen: betaalmuur, inloggen, sluiten, opnieuw ophalen tot volledige kopie met beveiligde bestanden, herstart met behoud van sessie, verlopen sessie, geweigerd ophalen, uitloggen. Daarna is de opslagmap echt weg en krijgt de site geen sessiecookie meer.
- **Release-build:** `Deepdive.app` (18 MB) is gebouwd en start, maar de bovenstaande tests zijn op de debug-build gedaan.

## Niet getest

- **Windows**, bewust uitgesteld (zie boven).
- **Echt slepen vanuit Finder of een browser.** Alleen nagebootste sleepacties zijn getest, ook die op de kopie zelf.
- **De knop "Pdf kiezen"**, omdat die een dialoog van het systeem opent.
- **Plakken met Cmd+V buiten het invoerveld.**
- **Inloggen op echte sites.** Alleen de lokale testsite is doorlopen; er is op geen enkele echte site ingelogd. Niet getest zijn dus onder meer: of een echte krant na inloggen de hele tekst aan de verborgen webview geeft, inlogdiensten op een ander domein, en sites die ingebouwde webviews weigeren.
- **Het oordeel bij ingelogde pagina's van echte sites.** Dat ze dan `volledig` krijgen, is alleen op de testsite bewezen.
- **Tekenen van pdf-pagina's in een onzichtbaar venster:** dat staat stil tot het venster weer zichtbaar is. De tekstlaag en tekstkopie werken dan wel. Bij een zichtbaar venster zijn de pagina's goed getekend.

## Bekende beperkingen

- De uitslag per site kan per keer verschillen (zie NRC en Volkskrant), omdat sites varianten en cookie- en betaalmuren per bezoek anders tonen.
- Cookielagen en grote zwevende vlakken worden herkend met vuistregels, dus er kan iets blijven staan of onterecht verdwijnen. De app klikt nooit iets aan.
- De tekstkopie kan menu's of bijschriften bevatten, omdat de app bij twijfel liever te veel dan te weinig meeneemt.
- Ingesloten video's en grafieken worden een plaatsaanduiding met een link. Zwevende widgets vervallen.
- Bestanden achter een login op een ander domein dan de site (bijvoorbeeld een eigen cdn-domein met cookies) komen bewust niet mee.
- Uitloggen wist de sessie in de app. De site zelf kan die nog even als geldig zien; wie dat ook wil beëindigen, logt eerst op de site uit via "Site openen".
- Cookies zonder vervaldatum zijn niet apart getest over een herstart heen. De test gebruikt een cookie met vervaldatum. Bij zo'n sessiecookie kan opnieuw inloggen nodig zijn.
- Een inlog-pop-up opent in hetzelfde venster. Sites die een echte pop-up met terugkoppeling nodig hebben, kunnen daarop vastlopen.
- Sites op een gedeeld domein vallen onder één sessie wanneer de publieke-suffixlijst ze niet scheidt.
- Inloggen vraagt om macOS 14 of nieuwer. Dat is alleen op macOS 27 getest; de melding op oudere versies en de Windows-tak zijn niet uitgevoerd.

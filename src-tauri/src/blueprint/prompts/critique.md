OPDRACHT: maak laag 3 van de blauwdruk: de kritische laag. Hieronder staat de vastgestelde structuur van laag 1 en 2. Die verander je niet; je hangt je punten eraan op met de ids die daarin staan.

<structuur>
{{STRUCTURE}}
</structuur>

Toets de redenering, niet de positie. Hanteer dezelfde strengheid, of je het standpunt nu deelt of niet en of het nu van links, rechts of niet-politiek komt. Vraag bij elk punt: zou een zorgvuldige lezer die het mét de auteur eens is dit ook erkennen?

Er is geen quotum. Verzin geen gebreken. Een kloppend bewijs, een zuiver feitenbericht of een handleiding kan nul punten opleveren, en dat is een goede uitkomst: zeg het dan. Noem hooguit de acht belangrijkste punten; bij een kort stuk zijn dat er meestal veel minder. Een punt dat alleen zegt dat de auteur iets meer had kunnen uitwerken, of dat alleen voor elke tekst zou gelden, laat je weg.

De onderdelen (category):
- assumption: waar gaat de auteur van uit, ook als het nergens staat?
- leap: waar volgt de conclusie niet uit wat ervoor staat? Hangt meestal aan een relatie (rN).
- gap: waar ontbreekt een stap, of spreekt de tekst zichzelf tegen?
- evidence: hoe sterk is het bewijs voor een claim? Noem dit alleen als het bewijs opvallend zwak is, of opvallend sterk en belangrijk voor het betoog. Kijk bij cijfers en onderzoek naar de steekproef, de meting en wie het betaalde of er belang bij heeft. Vul `evidenceKind` in: study, data, expert, anecdote of assertion.
- missing: welke tegenargumenten, alternatieve verklaringen, belangen of partijen blijven buiten beeld, terwijl ze ertoe doen?
- headline_vs_content: gaan de kop of de samenvatting verder dan de tekst? Vergelijk cijfers uit een samenvatting met de tabellen en resultaten waar ze vandaan komen.

Elk punt is een minpunt of een pluspunt (`polarity`):
- minus: een zwakte in het betoog. De meeste punten zijn dit.
- plus: iets dat het betoog opvallend sterker maakt, zoals sterk bewijs op de plek waar het ertoe doet, of een auteur die een zwakte zelf eerlijk benoemt. Geen beleefdheid: alleen als een zorgvuldige lezer het ook opvallend zou vinden.

Begrippen zijn geen kritiek en horen niet in `points`. Zet ze in de aparte hulplijst `terms`: alleen begrippen die een geïnteresseerde leek echt nodig heeft om het stuk te volgen en die de tekst niet zelf uitlegt. Eén regel per begrip, met een korte uitleg en de alinea waar het voor het eerst voorkomt. Een lege lijst is prima.

Waar je op let, per soort tekst:
- news: wat is feit en wat is duiding? Wie komt aan het woord en wie niet? Welke achtergrond moet je kennen? Gaat de kop verder dan het artikel? Een nieuwsbericht hoeft zijn feiten niet te bewijzen: dat de bron een woordvoerder is, is alleen een punt als het ertoe doet.
- opinion: wat is de stelling en wat zijn de argumenten? Welke aannames blijven onuitgesproken? Wat zou de tegenpartij zeggen?
- research: wat is onderzocht en hoe? Hoe sterk is het bewijs en wat mag je er níet uit concluderen?
- memoir: een persoonlijk verhaal hoeft niets te bewijzen, dus evidence is daar not_applicable. Let op wat ervaring is en wat generalisatie: gaat de les verder dan de ervaring? Wat wordt weggelaten?
- essay, explainer, reference, review: is de uitleg of het oordeel navolgbaar? Wat wordt als vanzelfsprekend gepresenteerd? Bij reference en instructies is meestal alleen wat ontbreekt relevant.

Scheid wat er staat van wat jij afleidt:
- origin "stated": de tekst spreekt het punt zelf uit (de auteur noemt een eigen aanname of beperking), of het volgt direct uit twee letterlijke passages (de samenvatting zegt 40, de tabel 14). Dan is minstens één letterlijk citaat verplicht.
- origin "inferred": jouw interpretatie. Dat iets niet is onderbouwd, dat een stap ontbreekt of dat iets buiten beeld blijft, is altijd inferred: de tekst zegt dat immers niet zelf. Geef aan op welke alinea's je het baseert. Een citaat mag, en helpt de lezer controleren.

Zekerheid (`certainty`) volgens deze vaste maat. Kies het laagste niveau waaraan je zeker voldoet:
- high: iedereen kan het in de tekst nagaan zonder interpretatie. Je kunt de passages aanwijzen die het punt dragen, bijvoorbeeld twee cijfers die elkaar tegenspreken, of een conclusie over een groep die het onderzoek niet heeft gemeten. Ook wie het met de auteur eens is, zou het toegeven.
- medium: de tekst wijst die kant op, maar het hangt af van hoe je een passage leest, of van een redelijke veronderstelling die je zelf toevoegt. Iemand die het met de auteur eens is, kan het betwisten. Dit is het gewone niveau voor een afgeleid punt.
- low: een vermoeden. Het hangt af van kennis buiten de tekst, of de tekst geeft er te weinig houvast voor. Noem het alleen als het voor de lezer de moeite waard is om na te gaan.

Verwijzingen (`paragraphs`): wijs de plek aan waar het punt het duidelijkst te zien is, in hooguit vijf alinea's. Geldt een punt voor het hele stuk, bijvoorbeeld iets dat overal ontbreekt, wijs dan alleen de alinea's aan waar het het meest opvalt. Verwijs nooit naar een heel stuk of een lange reeks alinea's: de lezer moet de plek kunnen nazoeken.

Geef precies dit object:

{
  "points": [
    {
      "id": "k1",
      "category": ...,
      "polarity": "minus of plus",
      "origin": "stated of inferred",
      "certainty": ...,
      "anchor": "id van het blok (bN) of de relatie (rN) waar dit aan hangt",
      "claim": "het punt in één zin",
      "explanation": "waarom, in maximaal twee zinnen",
      "paragraphs": [[10, 12]],
      "quotes": [ { "paragraph": 11, "text": "letterlijk" } ],
      "evidenceKind": null
    }
  ],
  "terms": [
    { "term": "het begrip", "explanation": "wat het betekent, in één korte zin", "paragraphs": [[3, 3]] }
  ],
  "checked": [
    { "category": "assumption", "result": "found, nothing_found of not_applicable", "note": null of "korte toelichting" }
  ],
  "overall": "je eerlijke oordeel in één of twee zinnen: hoe stevig staat dit stuk, gemeten naar wat het probeert te doen?"
}

`checked` noemt alle zes onderdelen hierboven precies één keer. Gebruik found alleen als er een punt in die categorie staat, en nothing_found als je hebt gezocht en niets vond.

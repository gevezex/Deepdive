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
- prior_knowledge: welke begrippen worden bekend verondersteld? Dit is geen gebrek maar hulp voor de lezer: alleen begrippen die een geïnteresseerde leek echt nodig heeft. Noem het begrip zelf in `claim` en leg het in `explanation` kort uit; één punt per begrip of nauw verwant groepje. "Er worden begrippen verondersteld" is geen punt.

Waar je op let, per soort tekst:
- news: wat is feit en wat is duiding? Wie komt aan het woord en wie niet? Welke achtergrond moet je kennen? Gaat de kop verder dan het artikel? Een nieuwsbericht hoeft zijn feiten niet te bewijzen: dat de bron een woordvoerder is, is alleen een punt als het ertoe doet.
- opinion: wat is de stelling en wat zijn de argumenten? Welke aannames blijven onuitgesproken? Wat zou de tegenpartij zeggen?
- research: wat is onderzocht en hoe? Hoe sterk is het bewijs en wat mag je er níet uit concluderen?
- memoir: een persoonlijk verhaal hoeft niets te bewijzen, dus evidence is daar not_applicable. Let op wat ervaring is en wat generalisatie: gaat de les verder dan de ervaring? Wat wordt weggelaten?
- essay, explainer, reference, review: is de uitleg of het oordeel navolgbaar? Wat wordt als vanzelfsprekend gepresenteerd? Bij reference en instructies zijn meestal alleen prior_knowledge en wat ontbreekt relevant.

Scheid wat er staat van wat jij afleidt:
- origin "stated": de tekst spreekt het punt zelf uit (de auteur noemt een eigen aanname of beperking), of het volgt direct uit twee letterlijke passages (de samenvatting zegt 40, de tabel 14). Dan is minstens één letterlijk citaat verplicht.
- origin "inferred": jouw interpretatie. Dat iets niet is onderbouwd, dat een stap ontbreekt of dat iets buiten beeld blijft, is altijd inferred: de tekst zegt dat immers niet zelf. Geef aan op welke alinea's je het baseert. Een citaat mag, en helpt de lezer controleren.
- certainty: high, medium of low: hoe zeker jij bent dat dit punt klopt. Wees eerlijk; low mag.

Geef precies dit object:

{
  "points": [
    {
      "id": "k1",
      "category": ...,
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
  "checked": [
    { "category": "assumption", "result": "found, nothing_found of not_applicable", "note": null of "korte toelichting" }
  ],
  "overall": "je eerlijke oordeel in één of twee zinnen: hoe stevig staat dit stuk, gemeten naar wat het probeert te doen?"
}

`checked` noemt alle zeven onderdelen precies één keer. Gebruik found alleen als er een punt in die categorie staat, en nothing_found als je hebt gezocht en niets vond.

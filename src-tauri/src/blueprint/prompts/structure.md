OPDRACHT: maak laag 1 en 2 van de blauwdruk: het doel van het stuk en de levensloop van het betoog. De kritische laag komt later; beoordeel nu nog niets.

De bron bevat soms ook menu's, voetteksten, reclame of een bronnenlijst. Die horen niet bij het stuk: laat ze buiten de blokken en geef in `articleParagraphs` aan waar het eigenlijke stuk begint en eindigt.

Schrijf de velden in precies deze volgorde:

{
  "textKind": een van news, opinion, research, memoir, essay, explainer, review, reference, other,
  "goal": {
    "main": { "kind": ..., "description": "wat de auteur hier doet, in één zin" },
    "secondary": [ { "kind": ..., "description": "..." } ]
  },
  "message": "wat de auteur wil dat de lezer meeneemt, in precies één zin",
  "occasion": { "text": "waarom dit is geschreven: wat klopt er niet of wat ontbreekt er", "origin": "stated of inferred", "paragraphs": [[1, 2]] } of null als het stuk daar niets over zegt en je het ook niet met redelijke zekerheid kunt afleiden,
  "summary": "de inhoud in maximaal vier zinnen",
  "articleParagraphs": [eerste, laatste],
  "blocks": [
    { "id": "b1", "role": ..., "title": "korte titel, maximaal zes woorden", "content": "wat er in deze stap gebeurt, in één of twee zinnen", "paragraphs": [[1, 2]], "quote": null of { "paragraph": 2, "text": "letterlijk kernzinnetje" } }
  ],
  "relations": [
    { "id": "r1", "block": "b2", "dependsOn": "b1", "kind": ..., "explanation": "hoe b2 op b1 steunt, in één korte zin" }
  ]
}

Toegestane waarden:
- goal.kind: explain_problem, offer_solution, vent_frustration, personal_experience, develop_concept, persuade, report_research, report_event, refute, evaluate, instruct, other. Bijdoelen alleen als ze er echt zijn; anders een lege lijst.
- role: occasion, thesis, concept, explanation, argument, evidence, example, objection, rebuttal, conclusion, question, method, results, interpretation, limitation, event, background, reaction, reflection, lesson, instruction, assessment, other.
- relation.kind: builds_on, evidence_for, example_of, answers, contrasts, follows_in_time, concludes.
- origin: stated als de auteur het zelf zegt, inferred als jij het afleidt.

De vorm past bij de soort tekst. Dwing er geen betoog in dat er niet is:
- news: de kern van het nieuws, dan wie wat zegt, achtergrond en wat er nog komt. Een nieuwsbericht is meestal geen redenering: gebruik vooral event, reaction en background, en follows_in_time of builds_on.
- opinion: stelling, argumenten, eventueel bezwaar en weerlegging, conclusie.
- research: vraag, methode, resultaten, interpretatie, beperkingen, conclusie.
- memoir: verhaallijn met gebeurtenissen en reflectie, met de les aan het eind. Geen bewijs zoeken.
- essay: de ontwikkeling van de gedachte, stap voor stap.
- explainer en reference: begrippen, uitleg en instructie in logische volgorde.
- review: wat wordt besproken, de beoordeling en de redenen.

Regels voor het diagram:
- Kies het aantal blokken naar wat het stuk nodig heeft: een kort bericht 2 tot 4, een lang stuk hooguit 12. Eén blok per stap in het betoog, niet per alinea.
- Blokken staan in de volgorde van de tekst. De alineabereiken overlappen niet en dekken samen het hele eigenlijke stuk, op wat losse koppen na.
- Relaties laten zien waarop iets steunt, niet alleen wat erna komt. `block` steunt op `dependsOn`, dus de pijl loopt van dependsOn naar block. Een blok kan op meerdere blokken steunen. Geen kringen.
- Elk id begint met b of r gevolgd door een nummer.

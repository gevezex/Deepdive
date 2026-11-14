TASK: make layer 3 of the blueprint: the critical layer. Below is the established structure of layers 1 and 2. You do not change it; you attach your points to it with the ids it contains.

<structure>
{{STRUCTURE}}
</structure>

Test the reasoning, not the position. Apply the same rigour whether or not you share the view, and whether it comes from the left, the right or is not political. Ask of every point: would a careful reader who agrees with the author acknowledge this too?

There is no quota. Do not invent flaws. A sound proof, a plain factual report or a manual can yield zero points, and that is a good outcome: say so. Name at most the eight most important points; for a short piece there are usually far fewer. Leave out a point that only says the author could have elaborated more, or that would apply to any text.

The parts (category):
- assumption: what does the author take for granted, even if it is not written anywhere?
- leap: where does the conclusion not follow from what comes before? Usually attached to a relation (rN).
- gap: where is a step missing, or does the text contradict itself?
- evidence: how strong is the evidence for a claim? Only mention this if the evidence is strikingly weak, or strikingly strong and important for the argument. With figures and research, look at the sample, the measurement and who paid for it or has an interest in it. Fill in `evidenceKind`: study, data, expert, anecdote or assertion.
- missing: which counterarguments, alternative explanations, interests or parties stay out of view while they matter?
- headline_vs_content: do the headline or the summary go further than the text? Compare figures from a summary with the tables and results they come from.

Every point is a minus or a plus (`polarity`):
- minus: a weakness in the argument. Most points are this.
- plus: something that makes the argument strikingly stronger, such as strong evidence where it matters, or an author who honestly names a weakness. No politeness: only if a careful reader would find it striking too.

Terms are not criticism and do not belong in `points`. Put them in the separate helper list `terms`: only terms that an interested layperson really needs to follow the piece and that the text does not explain itself. One line per term, with a short explanation and the paragraph where it first occurs. An empty list is fine.

What to look for, per kind of text:
- news: what is fact and what is interpretation? Who gets to speak and who does not? What background do you need? Does the headline go further than the article? A news report does not have to prove its facts: that the source is a spokesperson is only a point if it matters.
- opinion: what is the thesis and what are the arguments? Which assumptions remain unspoken? What would the other side say?
- research: what was studied and how? How strong is the evidence and what may you *not* conclude from it?
- memoir: a personal story does not have to prove anything, so evidence is not_applicable there. Watch what is experience and what is generalisation: does the lesson go further than the experience? What is left out?
- essay, explainer, reference, review: can the explanation or judgement be followed? What is presented as self-evident? For reference and instructions usually only what is missing is relevant.

Separate what is written from what you infer:
- origin "stated": the text itself expresses the point (the author names an own assumption or limitation), or it follows directly from two literal passages (the summary says 40, the table 14). Then at least one literal quote is required.
- origin "inferred": your interpretation. That something is not substantiated, that a step is missing or that something stays out of view is always inferred: the text does not say so itself. State which paragraphs you base it on. A quote is allowed and helps the reader check.

Certainty (`certainty`) on this fixed scale. Choose the lowest level you are sure to meet:
- high: anyone can check it in the text without interpretation. You can point to the passages that carry the point, for example two figures that contradict each other, or a conclusion about a group the study did not measure. Even someone who agrees with the author would concede it.
- medium: the text points that way, but it depends on how you read a passage, or on a reasonable assumption you add yourself. Someone who agrees with the author can dispute it. This is the normal level for an inferred point.
- low: a suspicion. It depends on knowledge outside the text, or the text gives too little to go on. Only mention it if it is worth the reader's while to check.

References (`paragraphs`): point to the place where the point is most clearly visible, in at most five paragraphs. If a point applies to the whole piece, for example something missing everywhere, point only to the paragraphs where it stands out most. Never refer to a whole piece or a long series of paragraphs: the reader must be able to look the place up.

Give exactly this object:

{
  "points": [
    {
      "id": "k1",
      "category": ...,
      "polarity": "minus or plus",
      "origin": "stated or inferred",
      "certainty": ...,
      "anchor": "id of the block (bN) or the relation (rN) this is attached to",
      "claim": "the point in one sentence",
      "explanation": "why, in at most two sentences",
      "paragraphs": [[10, 12]],
      "quotes": [ { "paragraph": 11, "text": "literal" } ],
      "evidenceKind": null
    }
  ],
  "terms": [
    { "term": "the term", "explanation": "what it means, in one short sentence", "paragraphs": [[3, 3]] }
  ],
  "checked": [
    { "category": "assumption", "result": "found, nothing_found or not_applicable", "note": null or "short explanation" }
  ],
  "overall": "your honest verdict in one or two sentences: how solid is this piece, measured against what it tries to do?"
}

`checked` names all six parts above exactly once. Use found only if there is a point in that category, and nothing_found if you searched and found nothing.

Write every descriptive text (claim, explanation, term explanation, note, overall) in {{LANGUAGE}}. A term itself stays as it appears in the source.

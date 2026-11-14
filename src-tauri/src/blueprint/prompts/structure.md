TASK: make layers 1 and 2 of the blueprint: the purpose of the piece and the life course of the argument. The critical layer comes later; do not judge anything yet.

The source sometimes also contains menus, footers, advertising or a reference list. They are not part of the piece: keep them out of the blocks and use `articleParagraphs` to say where the actual piece begins and ends.

Write the fields in exactly this order:

{
  "textKind": one of news, opinion, research, memoir, essay, explainer, review, reference, other,
  "goal": {
    "main": { "kind": ..., "description": "what the author does here, in one sentence" },
    "secondary": [ { "kind": ..., "description": "..." } ]
  },
  "message": "what the author wants the reader to take away, in exactly one sentence",
  "occasion": { "text": "why this was written: what is wrong or what is missing", "origin": "stated or inferred", "paragraphs": [[1, 2]] } or null if the piece says nothing about it and you cannot infer it with reasonable certainty either,
  "summary": "the content in at most four sentences",
  "articleParagraphs": [first, last],
  "blocks": [
    { "id": "b1", "role": ..., "title": "short title, at most six words", "content": "what happens in this step, in one or two sentences", "paragraphs": [[1, 2]], "quote": null or { "paragraph": 2, "text": "literal key phrase" } }
  ],
  "relations": [
    { "id": "r1", "block": "b2", "dependsOn": "b1", "kind": ..., "explanation": "how b2 rests on b1, in one short sentence" }
  ]
}

Allowed values:
- goal.kind: explain_problem, offer_solution, vent_frustration, personal_experience, develop_concept, persuade, report_research, report_event, refute, evaluate, instruct, other. Secondary goals only if they are really there; otherwise an empty list.
- role: occasion, thesis, concept, explanation, argument, evidence, example, objection, rebuttal, conclusion, question, method, results, interpretation, limitation, event, background, reaction, reflection, lesson, instruction, assessment, other.
- relation.kind: builds_on, evidence_for, example_of, answers, contrasts, follows_in_time, concludes.
- origin: stated if the author says it, inferred if you infer it.

The shape fits the kind of text. Do not force an argument that is not there:
- news: the core of the news, then who says what, background and what comes next. A news report is usually not a line of reasoning: mostly use event, reaction and background, and follows_in_time or builds_on.
- opinion: thesis, arguments, possibly objection and rebuttal, conclusion.
- research: question, method, results, interpretation, limitations, conclusion.
- memoir: a story line with events and reflection, with the lesson at the end. Do not look for evidence.
- essay: the development of the thought, step by step.
- explainer and reference: concepts, explanation and instruction in logical order.
- review: what is discussed, the assessment and the reasons.

Rules for the diagram:
- Choose the number of blocks the piece needs: a short report 2 to 4, a long piece at most 12. One block per step in the argument, not per paragraph.
- Blocks are in the order of the text. The paragraph ranges do not overlap and together cover the whole actual piece, apart from a few loose headings.
- Relations show what something rests on, not just what comes next. `block` rests on `dependsOn`, so the arrow runs from dependsOn to block. A block can rest on several blocks. No cycles.
- Every id starts with b or r followed by a number.

Write every descriptive text (description, message, occasion.text, summary, title, content, explanation) in {{LANGUAGE}}.

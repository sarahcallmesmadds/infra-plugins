// The pattern catalogue, kept apart from the scoring so it can be read and
// argued with on its own.
//
// Sources: Wikipedia's "Signs of AI writing" project page, The Algorithmic
// Bridge's ten signs, and the style battery in the author's own notes.
//
// Everything here is a SOFT signal unless marked otherwise. Each one appears
// in perfectly good human writing. They mean something in aggregate and
// nothing alone, which is why the scorer counts distinct categories rather
// than raw hits.

'use strict';

// Words that spiked in machine prose. Grouped by the era they became a tell,
// because the set moves and a stale list quietly stops working.
// Matching is by substring, so only the shortest form of each word belongs
// here. Listing both "underscore" and "underscores" made a single word score
// twice, which let one word trip a category on its own and quietly defeated
// the whole point of requiring signals to stack.
const VOCABULARY = [
  // 2023 to mid-2024
  'delve', 'tapestry', 'testament', 'boasts', 'bolstered', 'meticulous',
  'intricate', 'interplay', 'pivotal', 'vibrant', 'garner', 'enduring',
  'underscore', 'crucial',
  // mid-2024 onward
  'align with', 'enhance', 'foster', 'highlighting', 'showcase', 'landscape',
  'ecosystem',
  // the business-casual register
  'leverage', 'robust', 'streamline', 'seamless', 'holistic', 'synergy',
  'utilize', 'facilitate', 'myriad', 'plethora', 'nuanced', 'comprehensive',
  'foundational', 'game-changer', 'cutting-edge', 'best-in-class',
  'actionable insights', 'unlock',
];

// Phrases the author has ruled out for her own writing. These are not machine
// tells and they are not a matter of taste, they are a standing instruction, so
// they are HARD and one hit is enough. Everything else in this file is graded
// on aggregate; this list is not.
//
// Matching is by substring on lowercased text, same as the soft lists, so keep
// each entry to the shortest distinctive form.
//
// Added 2026-08-11 after four consecutive drafts of a LinkedIn post shipped
// with "worth stealing" in them and the tool reported all four clean. Her
// ruling was "absolutely not okay to say to me or to say as me ever", which is
// a different class of thing from "delve" and is why it does not live in
// VOCABULARY.
const HOUSE_RULES = [
  // Steal framing, rule 12. Any form of it.
  'worth stealing',
  'go steal',
  'steal this',
  'steal it',
  'stealable',
  // Telling the reader what they already have or already know, rule 13. These
  // are the specific shapes she cut, kept narrow on purpose: the complaint was
  // about being told about your own business, not about the word "your".
  'you already know',
  'your ad account already',
  'already knows which',
  "here's the thing",
];

// Replacing plain "is" and "has" with something that sounds weightier. One of
// the most reliable tells, and one almost nobody edits out.
const COPULA_AVOIDANCE = [
  'serves as', 'stands as', 'functions as', 'operates as', 'represents a',
  'marks a', 'emerges as', 'positions itself as', 'boasts a', 'features a',
];

// Inflating the importance of whatever is being described.
const SIGNIFICANCE = [
  'a testament to', 'underscores the importance',
  'plays a crucial role', 'plays a pivotal role', 'plays a vital role',
  'marking a pivotal', 'represents a shift', 'key turning point',
  'reflects broader', 'stands as a reminder', 'serves as a reminder',
];

// A present participle bolted onto the end of a sentence to make a plain fact
// sound analytical. "The bridge opened in 1974, underscoring the region's growth."
const PARTICIPLE_TACK = [
  ', highlighting', ', underscoring', ', emphasizing', ', ensuring',
  ', reflecting', ', symbolizing', ', fostering', ', contributing to',
  ', enhancing', ', showcasing', ', cementing', ', solidifying',
];

// Claims sourced to nobody.
const WEASEL_ATTRIBUTION = [
  'industry reports', 'observers have cited', 'experts argue', 'experts agree',
  'some critics argue', 'studies show', 'research suggests',
  'it is well established', 'it is widely believed', 'many believe',
];

// Balancing every claim rather than holding a position.
const HEDGES = [
  'it depends', 'there are pros and cons', 'both approaches have merit',
  'ultimately the choice', 'each has its own', 'it varies',
  'on the other hand', 'that said', 'while it is true',
];

// Filler that carries no information.
const FILLER = [
  "it's important to note", 'it is important to note', "it's worth noting",
  'in today’s world', "in today's world", 'in the world of', 'when it comes to',
  'at the end of the day', 'the key is', 'navigate the complexities',
  'in the realm of', 'in an era where', 'more than ever',
];

// Forced energy, usually at the top or bottom of a piece.
const FAKE_ENTHUSIASM = [
  "let's dive in", 'lets dive in', "let's get started", 'buckle up',
  "here's the kicker", "and that's the beauty of", 'the best part',
];

// A practical document suddenly reaching for grandeur.
const MELODRAMA = [
  'the future of humanity', 'empowering the future', 'transform the way we',
  'revolutionize the way', 'a new era of', 'change everything',
  'the possibilities are endless',
];

// Leftovers from the tool that generated the text. These are HARD evidence,
// not style: a human writing by hand does not produce them. Sourced from the
// Wikipedia project page, which tracks them per model.
const TOOL_ARTEFACTS = [
  'contentReference', 'oaicite', 'attributableIndex',
  'turn0search', 'turn0news', 'turn1search',
  '[cite:', '[span_', 'grok_render_citation_card_json', 'grok_card',
  'ppl-ai-file-upload', 'attached_file',
  'As an AI language model', 'I cannot browse the internet',
  'knowledge cutoff', 'As of my last update',
];

module.exports = {
  VOCABULARY,
  COPULA_AVOIDANCE,
  SIGNIFICANCE,
  PARTICIPLE_TACK,
  WEASEL_ATTRIBUTION,
  HEDGES,
  FILLER,
  FAKE_ENTHUSIASM,
  MELODRAMA,
  TOOL_ARTEFACTS,
  HOUSE_RULES,
};

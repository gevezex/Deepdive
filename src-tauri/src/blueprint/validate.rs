//! De controles op wat het model teruggeeft. Ze herstellen wat zeker is en markeren de rest; ze verzinnen nooit
//! een verwijzing. Wat niet klopt gaat weg of komt zonder verwijzing terug, met een `Issue` erbij.

use super::schema::*;
use crate::model::Block as SourceBlock;
use std::collections::{BTreeSet, HashMap, HashSet};

/// De bron, klaar om tegen te controleren.
pub struct SourceIndex {
    numbers: BTreeSet<u32>,
    normalized: Vec<(u32, String)>,
}

impl SourceIndex {
    pub fn new(blocks: &[SourceBlock]) -> Self {
        Self { numbers: blocks.iter().map(|b| b.n).collect(), normalized: blocks.iter().map(|b| (b.n, normalize(&b.text))).collect() }
    }
}

/// Maakt typografie gelijk: rechte en krullende aanhalingstekens, soorten streepjes, witruimte, afbreekstreepjes.
/// Een letter blijft een letter; hoofdletters tellen dus mee.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' | '`' | '\u{00B4}' => out.push('\''),
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' | '\u{00AB}' | '\u{00BB}' => out.push('"'),
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' | '\u{2212}' => out.push('-'),
            '\u{2026}' => out.push_str("..."),
            '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' => {}
            c if c.is_whitespace() => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            c => out.push(c),
        }
    }
    // Een pdf breekt woorden af aan het regeleinde: "ver- gelijken". Aan beide kanten op dezelfde manier herstellen.
    out.trim().replace("- ", "-")
}

fn strip_outer_quotes(text: &str) -> &str {
    let t = text.trim();
    t.trim_matches(|c: char| matches!(c, '"' | '\'' | '\u{201C}' | '\u{201D}' | '\u{2018}' | '\u{2019}' | '\u{201E}' | '\u{00AB}' | '\u{00BB}')).trim()
}

/// Boven dit aantal alinea's is een verwijzing niet meer na te zoeken. In de test van stap 3a wees Sushi in 16 punten
/// naar meer dan 20 alinea's en ChatGPT in 5 punten naar meer dan 8.
const MAX_POINT_PARAGRAPHS: usize = 8;
/// In een kort stuk telt ook de helft van het stuk als breed, maar een paar alinea's is altijd na te zoeken.
const MIN_BROAD_SHARE_PARAGRAPHS: usize = 5;

struct Checker<'a> {
    index: &'a SourceIndex,
    issues: &'a mut Vec<Issue>,
    checks: &'a mut Checks,
}

impl Checker<'_> {
    fn issue(&mut self, code: &str, path: &str, detail: String) {
        self.issues.push(Issue { code: code.into(), path: path.into(), detail });
    }

    /// Maakt van de alineabereiken wat echt bestaat. Geeft terug of er nog iets over is.
    fn ranges(&mut self, ranges: &mut Vec<ParagraphRange>, path: &str) -> bool {
        let (Some(&min), Some(&max)) = (self.index.numbers.first(), self.index.numbers.last()) else {
            ranges.clear();
            return false;
        };
        let mut kept = vec![];
        for &(a, b) in ranges.iter() {
            let (lo, hi) = (a.min(b), a.max(b));
            if hi < min || lo > max || self.index.numbers.range(lo..=hi).next().is_none() {
                self.checks.ranges_fixed += 1;
                self.issue("range_removed", path, format!("¶{a}–{b} bestaat niet in de bron en is weggehaald."));
                continue;
            }
            let fixed = (lo.max(min), hi.min(max));
            if fixed != (a, b) {
                self.checks.ranges_fixed += 1;
                self.issue("range_fixed", path, format!("¶{a}–{b} is ingekort tot ¶{}–{}.", fixed.0, fixed.1));
            }
            kept.push(fixed);
        }
        *ranges = kept;
        !ranges.is_empty()
    }

    /// Wijst deze verwijzing naar te veel alinea's om na te zoeken? Telt alleen alinea's die echt bestaan.
    fn is_broad(&self, ranges: &[ParagraphRange], article: ParagraphRange) -> bool {
        let named: BTreeSet<u32> = ranges.iter().flat_map(|&(lo, hi)| self.index.numbers.range(lo..=hi).copied()).collect();
        let article_size = self.index.numbers.range(article.0..=article.1).count();
        named.len() > MAX_POINT_PARAGRAPHS || (named.len() >= MIN_BROAD_SHARE_PARAGRAPHS && named.len() * 2 > article_size)
    }

    /// Zoekt het citaat letterlijk op. Staat het in een andere alinea, dan klopt daarna de verwijzing.
    /// Geeft terug of het citaat mag blijven.
    fn quote(&mut self, quote: &mut Quote, path: &str) -> bool {
        self.checks.quotes.total += 1;
        quote.verified = false;
        quote.text = strip_outer_quotes(&quote.text).to_string();
        let needle = normalize(&quote.text);
        if needle.is_empty() {
            self.checks.quotes.removed += 1;
            self.issue("quote_removed", path, "Leeg citaat weggehaald.".into());
            return false;
        }
        let matches = |n: u32| self.index.normalized.iter().any(|(m, text)| *m == n && text.contains(&needle));
        if matches(quote.paragraph) {
            quote.verified = true;
            self.checks.quotes.verified += 1;
            return true;
        }
        if let Some((n, _)) = self.index.normalized.iter().find(|(_, text)| text.contains(&needle)) {
            let n = *n;
            self.issue("quote_moved", path, format!("Citaat stond niet in ¶{} maar in ¶{n}. Verwijzing verbeterd.", quote.paragraph));
            quote.paragraph = n;
            quote.verified = true;
            self.checks.quotes.moved += 1;
            return true;
        }
        self.checks.quotes.removed += 1;
        self.issue("quote_removed", path, format!("Citaat bij ¶{} staat niet letterlijk in de bron en is weggehaald.", quote.paragraph));
        false
    }
}

/// Fouten waarvoor het model een tweede kans krijgt: zonder deze velden is er geen blauwdruk.
pub fn structure_errors(s: &Structure) -> Vec<String> {
    let mut errors = vec![];
    if s.message.trim().is_empty() {
        errors.push("`message` is leeg.".to_string());
    }
    if s.summary.trim().is_empty() {
        errors.push("`summary` is leeg.".to_string());
    }
    if s.goal.main.description.trim().is_empty() {
        errors.push("`goal.main.description` is leeg.".to_string());
    }
    if s.blocks.is_empty() {
        errors.push("`blocks` is leeg.".to_string());
    }
    if s.blocks.iter().any(|b| b.content.trim().is_empty() || b.title.trim().is_empty()) {
        errors.push("Elk blok heeft een `title` en `content` nodig.".to_string());
    }
    errors
}

pub fn check_structure(s: &mut Structure, index: &SourceIndex, issues: &mut Vec<Issue>, checks: &mut Checks) {
    let mut c = Checker { index, issues, checks };

    if s.message.chars().count() > 400 {
        c.issue("message_long", "message", "De boodschap is langer dan één zin hoort te zijn.".into());
    }
    if let Some(occasion) = &mut s.occasion {
        c.ranges(&mut occasion.paragraphs, "occasion");
    }

    let mut article = vec![s.article_paragraphs];
    if c.ranges(&mut article, "articleParagraphs") {
        s.article_paragraphs = article[0];
    } else if let (Some(&min), Some(&max)) = (index.numbers.first(), index.numbers.last()) {
        s.article_paragraphs = (min, max);
    }

    // Twee blokken met hetzelfde id zouden een relatie dubbelzinnig maken: het eerste blijft staan.
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(s.blocks.len());
    for mut block in std::mem::take(&mut s.blocks) {
        let path = format!("blocks.{}", block.id);
        if !seen.insert(block.id.clone()) {
            c.issue("block_duplicate", &path, "Dubbel blok-id; het tweede blok is weggehaald.".into());
            continue;
        }
        if !c.ranges(&mut block.paragraphs, &path) {
            c.issue("block_without_source", &path, "Dit blok verwijst naar geen enkele bestaande alinea.".into());
        }
        if let Some(mut quote) = block.quote.take() {
            if c.quote(&mut quote, &path) {
                block.quote = Some(quote);
            }
        }
        kept.push(block);
    }
    s.blocks = kept;

    let mut seen_relations = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut relations = Vec::with_capacity(s.relations.len());
    for relation in std::mem::take(&mut s.relations) {
        let path = format!("relations.{}", relation.id);
        let reason = if !seen.contains(&relation.block) || !seen.contains(&relation.depends_on) {
            Some("wijst naar een blok dat niet bestaat")
        } else if relation.block == relation.depends_on {
            Some("wijst naar zichzelf")
        } else if !seen_relations.insert((relation.block.clone(), relation.depends_on.clone())) {
            Some("staat er dubbel in")
        } else if !seen_ids.insert(relation.id.clone()) {
            Some("heeft een dubbel id")
        } else {
            None
        };
        match reason {
            Some(reason) => {
                c.checks.relations_removed += 1;
                c.issue("relation_removed", &path, format!("{} → {} {reason} en is weggehaald.", relation.depends_on, relation.block));
            }
            None => relations.push(relation),
        }
    }
    s.relations = relations;

    if let Some(path) = find_cycle(&s.relations) {
        c.issue("relation_cycle", "relations", format!("Kringredenering in de pijlen: {path}."));
    }

    let article: Vec<u32> = index.numbers.range(s.article_paragraphs.0..=s.article_paragraphs.1).copied().collect();
    let in_block = |n: u32| s.blocks.iter().any(|b| b.paragraphs.iter().any(|&(lo, hi)| lo <= n && n <= hi));
    let covered = article.iter().filter(|&&n| in_block(n)).count();
    c.checks.coverage = if article.is_empty() { 0.0 } else { covered as f32 / article.len() as f32 };
}

/// Een steun-op-relatie hoort geen kring te vormen. Geeft de kring terug als die er is.
fn find_cycle(relations: &[Relation]) -> Option<String> {
    let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
    for r in relations {
        next.entry(r.block.as_str()).or_default().push(r.depends_on.as_str());
    }
    fn visit<'a>(node: &'a str, next: &HashMap<&'a str, Vec<&'a str>>, stack: &mut Vec<&'a str>, done: &mut HashSet<&'a str>) -> Option<String> {
        if let Some(start) = stack.iter().position(|n| *n == node) {
            return Some(stack[start..].join(" → ") + " → " + node);
        }
        if !done.insert(node) {
            return None;
        }
        stack.push(node);
        for n in next.get(node).into_iter().flatten() {
            if let Some(found) = visit(n, next, stack, done) {
                return Some(found);
            }
        }
        stack.pop();
        None
    }
    let mut done = HashSet::new();
    let mut keys: Vec<&str> = next.keys().copied().collect();
    keys.sort();
    keys.into_iter().find_map(|node| visit(node, &next, &mut vec![], &mut done))
}

pub fn check_critique(critique: &mut Critique, s: &Structure, index: &SourceIndex, issues: &mut Vec<Issue>, checks: &mut Checks) {
    let mut c = Checker { index, issues, checks };
    let anchors: HashSet<&str> = s.blocks.iter().map(|b| b.id.as_str()).chain(s.relations.iter().map(|r| r.id.as_str())).collect();
    let mut ids = HashSet::new();
    for (i, point) in critique.points.iter_mut().enumerate() {
        if !ids.insert(point.id.clone()) {
            let fresh = format!("{}-{}", point.id, i + 1);
            c.issue("point_duplicate", &format!("points.{}", point.id), format!("Dubbel id, hernoemd naar {fresh}."));
            point.id = fresh.clone();
            ids.insert(fresh);
        }
        let path = format!("points.{}", point.id);
        if let Some(anchor) = &point.anchor {
            if !anchors.contains(anchor.as_str()) {
                c.checks.anchors_removed += 1;
                c.issue("anchor_removed", &path, format!("Het punt hing aan \"{anchor}\", dat niet bestaat. Het staat nu los."));
                point.anchor = None;
            }
        } else {
            c.issue("anchor_missing", &path, "Het punt hangt aan geen blok of relatie.".into());
        }
        if !c.ranges(&mut point.paragraphs, &path) {
            c.issue("point_without_source", &path, "Dit punt verwijst naar geen enkele bestaande alinea.".into());
        }
        point.broad = c.is_broad(&point.paragraphs, s.article_paragraphs);
        if point.broad {
            c.checks.broad_points += 1;
            c.issue("range_broad", &path, "Dit punt wijst naar te veel alinea's om na te zoeken. Springen gaat naar de eerste.".into());
        }
        let mut quotes = vec![];
        for mut quote in std::mem::take(&mut point.quotes) {
            if c.quote(&mut quote, &path) {
                quotes.push(quote);
            }
        }
        point.quotes = quotes;
        if point.origin == Origin::Stated && point.quotes.is_empty() {
            c.issue("stated_without_quote", &path, "Volgens het model staat dit in de tekst, maar er is geen controleerbaar citaat.".into());
        }
    }

    for term in &mut critique.terms {
        let path = format!("terms.{}", term.term);
        c.ranges(&mut term.paragraphs, &path);
    }

    // De lijst per onderdeel moet kloppen met de punten: alle onderdelen één keer, en "gevonden" alleen met een punt.
    let found: HashSet<Category> = critique.points.iter().map(|p| p.category).collect();
    let mut checked: Vec<CategoryCheck> = vec![];
    for check in std::mem::take(&mut critique.checked) {
        if !checked.iter().any(|k| k.category == check.category) {
            checked.push(check);
        }
    }
    for category in Category::ALL {
        let has_points = found.contains(&category);
        match checked.iter_mut().find(|k| k.category == category) {
            Some(check) => {
                if has_points && check.result != CheckResult::Found {
                    c.issue("check_contradiction", "checked", format!("{category:?} had punten maar stond niet als gevonden. Gecorrigeerd."));
                    check.result = CheckResult::Found;
                } else if !has_points && check.result == CheckResult::Found {
                    c.issue("check_contradiction", "checked", format!("{category:?} stond als gevonden maar heeft geen punten. Gecorrigeerd."));
                    check.result = CheckResult::NothingFound;
                }
            }
            None => {
                c.issue("check_missing", "checked", format!("{category:?} ontbrak in de lijst."));
                if has_points {
                    checked.push(CategoryCheck { category, result: CheckResult::Found, note: None });
                }
            }
        }
    }
    critique.checked = checked;
}

//! Oordeel over de vraag of een vastgelegde pagina het hele stuk bevat. Geen grens op woordenaantal:
//! een kort bericht zonder aanwijzingen is gewoon volledig. Het oordeel weegt signalen uit de pagina.
//! De pagina kan die signalen beïnvloeden, dus dit is een hulpmiddel en geen beveiliging.

use crate::engine::{PageSignals, RenderedPage};
use crate::model::{Completeness, CompletenessSignal, CompletenessVerdict};
use regex::Regex;
use std::sync::OnceLock;
use url::Url;

const INCOMPLETE_FROM: i32 = 3;
/// Binnen het stuk telt een blok alleen als er daarna nog maar weinig tekst volgt.
const MAX_WORDS_AFTER_GATE: u32 = 120;

/// Teksten die een lezer alleen ziet als het stuk ophoudt. Algemene woorden als "abonneren" staan hier
/// bewust niet in: die staan ook op volledige artikelen, in menu's en onder aan de pagina.
const GATE_PHRASES: &[&str] = &[
    // Nederlands
    "om verder te lezen", "om dit artikel te lezen", "om het hele artikel", "om het volledige artikel", "lees verder met",
    "lees dit artikel verder", "wil je verder lezen", "verder lezen?", "dit artikel is alleen", "alleen voor abonnees",
    "exclusief voor abonnees", "speciaal voor abonnees", "alleen voor leden", "al abonnee?", "ben je al abonnee",
    "ben je abonnee", "heb je al een abonnement", "heeft u al een abonnement", "lees het hele artikel", "lees het volledige artikel",
    "lees onbeperkt", "registreer je gratis", "maak een gratis account", "plus-artikel", "plusartikel", "premium-artikel",
    // Engels
    "subscribe to continue", "subscribe to read", "subscribe now to", "continue reading with", "to continue reading", "keep reading with",
    "keep reading for", "sign in to continue", "sign in to read", "log in to continue", "log in to read", "login to read",
    "already a subscriber", "already subscribed", "read the full story", "read the full article", "read the rest of this",
    "the rest of this article", "this story is for", "this article is for", "this post is for paid", "for paid subscribers",
    "subscribers only", "subscriber-only", "subscriber only", "members only", "member-only", "available to medium members",
    "access through your institution", "access options", "buy this article", "rent or buy", "purchase this article",
    "get full access", "unlock this article", "unlock this story", "start your free trial", "become a member to",
    "create an account to read", "create a free account to", "you have reached your limit", "you've reached your limit",
    "free articles remaining", "free article remaining",
];

/// Staan alleen op een artikel dat je niet kunt lezen. Daarna volgen vaak nog bronnen en auteurs, dus de
/// hoeveelheid tekst erna zegt hier niets.
const DECISIVE_PHRASES: &[&str] = &["access through your institution", "rent or buy", "buy this article", "purchase this article"];

fn login_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)/(login|log-in|signin|sign-in|inloggen|aanmelden|sso)(/|$|\.|\?)").unwrap())
}

fn matching_phrase(text: &str) -> Option<&'static str> {
    let low = text.to_lowercase().replace('’', "'");
    GATE_PHRASES.iter().copied().find(|p| low.contains(p))
}

fn snippet(text: &str) -> String {
    let t: String = text.chars().take(110).collect();
    if t.len() < text.len() { format!("{t}…") } else { t }
}

/// Een tekst die stopt zonder leesteken. Bijschriften en kopjes tellen niet mee.
fn ending(page: &RenderedPage) -> Option<Ending> {
    let last = page.blocks.iter().rev().find(|b| b.kind == "paragraph" && b.text.split_whitespace().count() >= 12)?;
    let text = last.text.trim_end();
    if text.ends_with('…') || text.ends_with("...") {
        return Some(Ending::Dots);
    }
    let c = text.chars().last()?;
    (!(".!?:;\"”’'»)]}".contains(c) || c.is_ascii_digit())).then_some(Ending::Open)
}

enum Ending {
    Dots,
    Open,
}

struct Tally {
    score: i32,
    signals: Vec<CompletenessSignal>,
}

impl Tally {
    fn add(&mut self, key: &str, weight: i32, detail: String) {
        self.score += weight;
        self.signals.push(CompletenessSignal { key: key.into(), weight, detail });
    }
}

fn weigh_gate(tally: &mut Tally, s: &PageSignals) {
    let mut found: Vec<(&'static str, &str)> = vec![];
    for c in &s.gate_candidates {
        let Some(p) = matching_phrase(&c.text) else { continue };
        let counts = matches!(c.place.as_str(), "overlay" | "after") || (c.place == "in" && (c.words_after <= MAX_WORDS_AFTER_GATE || DECISIVE_PHRASES.contains(&p)));
        if counts {
            if !found.iter().any(|(q, _)| *q == p) {
                found.push((p, &c.text));
            }
        }
    }
    if let Some((_, text)) = found.first() {
        tally.add("gate_text", 4, format!("Op de pagina staat: \"{}\"", snippet(text)));
    }
    if found.len() > 1 {
        tally.add("gate_text_more", 1, format!("Er staan {} van zulke teksten op de pagina.", found.len()));
    }
    if let Some(name) = s.gate_elements.first() {
        tally.add("gate_element", 2, format!("Op de pagina staat een afsluitend blok ({}).", snippet(name)));
    }
}

/// `has_session`: de pagina is met een bewaarde sessie opgehaald. Gestructureerde data blijft dan vaak
/// "niet gratis" zeggen terwijl de hele tekst er staat, dus die aanwijzing weegt minder.
pub fn judge(page: &RenderedPage, has_session: bool) -> Completeness {
    let s = &page.signals;
    let words: u32 = page.blocks.iter().map(|b| b.text.split_whitespace().count() as u32).sum();
    let mut tally = Tally { score: 0, signals: vec![] };

    weigh_gate(&mut tally, s);
    let locked = s.ld_free.iter().any(|f| !*f) || s.content_tier.as_deref().is_some_and(|t| matches!(t.to_ascii_lowercase().as_str(), "locked" | "metered"));
    let gated = tally.score > 0;

    let claimed = s.ld_body_words.into_iter().chain(s.ld_word_count).max();
    let mut length_confirmed = false;
    if let Some(claimed) = claimed.filter(|c| *c >= 50) {
        // Op een afgesloten pagina bevat de gestructureerde data soms alleen het begin (The Verge).
        // Een korte opgave bewijst daar dus niets; een lange wel, want dan staat die tekst er echt.
        let trustworthy = claimed >= 600 || (!locked && !gated);
        if words as f32 >= claimed as f32 * 0.8 && trustworthy {
            length_confirmed = true;
            tally.add("length_matches", -5, format!("De pagina geeft zelf {claimed} woorden op en er zijn er {words} gevonden."));
        } else if claimed as f32 >= words as f32 * 1.6 {
            tally.add("length_short", 4, format!("De pagina geeft zelf {claimed} woorden op, maar er zijn er maar {words} gevonden."));
        }
    }

    if locked && !length_confirmed {
        tally.add("not_free", if has_session { 1 } else { 2 }, "De pagina meldt zelf dat het stuk niet vrij toegankelijk is.".into());
    } else if !locked && s.ld_free.iter().any(|f| *f) {
        tally.add("free", -2, "De pagina meldt zelf dat het stuk gratis is.".into());
    }

    if s.password_field && words < 400 {
        tally.add("password_field", 3, "Op de pagina staat een inlogformulier.".into());
    }
    if let Ok(final_url) = Url::parse(&page.final_url) {
        if login_path().is_match(final_url.path()) && words < 400 {
            tally.add("login_redirect", 4, format!("De site stuurde door naar een inlogpagina ({}).", final_url.host_str().unwrap_or("")));
        }
    }
    if s.clipped {
        tally.add("clipped", 2, "De tekst wordt op de pagina afgekapt.".into());
    }
    if s.fade {
        tally.add("fade", 1, "De tekst loopt onderaan weg in een vervaging.".into());
    }
    match ending(page) {
        Some(Ending::Dots) => tally.add("ends_with_dots", 2, "De tekst eindigt met puntjes.".into()),
        Some(Ending::Open) => tally.add("ends_mid_sentence", 1, "De tekst stopt midden in een zin.".into()),
        None => {}
    }
    if s.page_words > 0 && words < 500 && (words as f32) < s.page_words as f32 * 0.2 {
        tally.add("small_share", 1, format!("Het stuk is maar een klein deel van de pagina ({words} van {} woorden).", s.page_words));
    }
    if words >= 1200 {
        tally.add("long_text", -3, format!("Het stuk is lang ({words} woorden)."));
    } else if words >= 600 {
        tally.add("fair_length", -1, format!("Het stuk heeft een behoorlijke lengte ({words} woorden)."));
    }

    let verdict = match tally.score {
        s if s >= INCOMPLETE_FROM => CompletenessVerdict::LikelyIncomplete,
        s if s <= 0 => CompletenessVerdict::Complete,
        _ => CompletenessVerdict::Unknown,
    };
    let reason = reason_for(verdict, &tally.signals, has_session);
    Completeness { verdict, reason, signals: tally.signals, accepted_by_user: false }
}

fn reason_for(verdict: CompletenessVerdict, signals: &[CompletenessSignal], has_session: bool) -> String {
    let mut positive: Vec<&CompletenessSignal> = signals.iter().filter(|s| s.weight > 0).collect();
    positive.sort_by_key(|s| -s.weight);
    let top = positive.iter().take(2).map(|s| s.detail.as_str()).collect::<Vec<_>>().join(" ");
    match verdict {
        CompletenessVerdict::LikelyIncomplete if has_session => format!("{top} Je bent op deze site ingelogd, maar de sessie is misschien verlopen of je abonnement geeft geen toegang tot dit stuk."),
        CompletenessVerdict::LikelyIncomplete => top,
        CompletenessVerdict::Unknown => format!("Een enkele zwakke aanwijzing: {top}"),
        CompletenessVerdict::Complete => match signals.iter().find(|s| s.key == "length_matches") {
            Some(s) => s.detail.clone(),
            None => "Er zijn geen aanwijzingen gevonden dat er tekst ontbreekt.".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{GateCandidate, RawBlock};

    fn page(words: usize, end: &str, signals: PageSignals) -> RenderedPage {
        let filler = vec!["woord"; words.saturating_sub(end.split_whitespace().count())].join(" ");
        RenderedPage {
            html: String::new(),
            final_url: "https://krant.example/stuk".into(),
            title: None,
            document_title: None,
            author: None,
            site_name: None,
            published: None,
            lang: None,
            blocks: vec![RawBlock { kind: "paragraph".into(), level: None, text: format!("{filler} {end}") }],
            signals,
            session_cookies: vec![],
        }
    }

    fn gate(text: &str, place: &str, words_after: u32) -> GateCandidate {
        GateCandidate { text: text.into(), place: place.into(), words_after }
    }

    fn verdict(p: &RenderedPage) -> CompletenessVerdict {
        judge(p, false).verdict
    }

    #[test]
    fn short_complete_post_gets_no_warning() {
        assert_eq!(verdict(&page(90, "Dat was het.", PageSignals::default())), CompletenessVerdict::Complete);
    }

    #[test]
    fn subscribe_text_in_menu_or_mid_article_does_not_count() {
        let s = PageSignals { gate_candidates: vec![gate("Al abonnee? Log in", "chrome", 0), gate("Lees het hele artikel", "in", 800)], ..Default::default() };
        assert_eq!(verdict(&page(1000, "Einde.", s)), CompletenessVerdict::Complete);
    }

    #[test]
    fn paywall_block_after_the_intro_is_recognised() {
        let s = PageSignals { gate_candidates: vec![gate("Log in om verder te lezen", "after", 0)], ..Default::default() };
        let j = judge(&page(150, "Het begin van het stuk.", s), false);
        assert_eq!(j.verdict, CompletenessVerdict::LikelyIncomplete);
        assert!(j.reason.contains("Log in om verder te lezen"), "{}", j.reason);
    }

    #[test]
    fn claimed_length_decides_in_both_directions() {
        let short = PageSignals { ld_word_count: Some(1200), ..Default::default() };
        assert_eq!(verdict(&page(200, "Een zin.", short)), CompletenessVerdict::LikelyIncomplete);
        let logged_in = PageSignals { ld_free: vec![false], ld_word_count: Some(1200), gate_candidates: vec![gate("Log in om verder te lezen", "after", 0)], ..Default::default() };
        assert_eq!(judge(&page(1250, "Einde.", logged_in), true).verdict, CompletenessVerdict::Complete);
    }

    #[test]
    fn not_free_alone_is_not_enough_for_a_warning() {
        let s = PageSignals { ld_free: vec![false], ..Default::default() };
        assert_eq!(verdict(&page(300, "Een zin.", s)), CompletenessVerdict::Unknown);
    }

    #[test]
    fn stopping_mid_sentence_alone_is_weak_but_adds_up() {
        assert_eq!(verdict(&page(300, "en toen liep hij naar de", PageSignals::default())), CompletenessVerdict::Unknown);
        let s = PageSignals { ld_free: vec![false], ..Default::default() };
        assert_eq!(verdict(&page(300, "en toen liep hij naar de", s)), CompletenessVerdict::LikelyIncomplete);
    }

    #[test]
    fn login_redirect_and_password_field_count() {
        let mut p = page(80, "Vul je gegevens in.", PageSignals { password_field: true, ..Default::default() });
        assert_eq!(verdict(&p), CompletenessVerdict::LikelyIncomplete);
        p.signals.password_field = false;
        p.final_url = "https://id.krant.example/login?next=/stuk".into();
        assert_eq!(verdict(&p), CompletenessVerdict::LikelyIncomplete);
    }

    #[test]
    fn long_article_with_promo_at_the_end_gets_no_warning() {
        let s = PageSignals { gate_candidates: vec![gate("Already a subscriber? Sign in", "after", 0)], ..Default::default() };
        assert_ne!(verdict(&page(3000, "Einde.", s)), CompletenessVerdict::LikelyIncomplete);
    }

    /// Echte signalen van de sitetest, zonder de tekst van de artikelen. Zie docs/site-test.md.
    #[test]
    fn known_sites_keep_their_verdict() {
        #[derive(serde::Deserialize)]
        struct Case {
            label: String,
            expected: String,
            page: RenderedPage,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("completeness_cases.json")).unwrap();
        assert!(!cases.is_empty());
        for c in &cases {
            let j = judge(&c.page, false);
            let incomplete = j.verdict == CompletenessVerdict::LikelyIncomplete;
            assert_eq!(incomplete, c.expected == "incomplete", "{}: {:?} {}", c.label, j.verdict, j.reason);
        }
    }
}

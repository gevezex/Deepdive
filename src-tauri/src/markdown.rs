//! Markdown als bron: herkennen of geplakte tekst markdown is, en het omzetten naar dezelfde genummerde
//! blokken als een website, met een nette opmaak voor de kopie. Ruwe html in de markdown wordt nooit
//! doorgegeven: alleen de tekst ervan blijft over.

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::sync::LazyLock;

use crate::model::Block;

static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,6}\s+\S").unwrap());
static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,3}(```|~~~)").unwrap());
static TABLE_RULE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[-*+]\s+\S").unwrap());
static ORDERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d{1,3}[.)]\s+\S").unwrap());
static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s{0,3}>\s?\S").unwrap());
static STRONG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*\*[^*\n]+\*\*|__[^_\n]+__").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!?\[[^\]\n]+\]\([^)\s]+\)").unwrap());
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]+`").unwrap());
static FRONT_MATTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)\r?\n").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<!--[\s\S]*?-->|<[^>]*>").unwrap());
static MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new("\u{1}(\\d+)\u{1}").unwrap());

/// Is dit markdown? Telt soorten kenmerken, geen losse regels: een lijstje met streepjes alleen is nog gewone tekst,
/// een kop met `#`, een codeblok of een tabel wel.
pub fn looks_like_markdown(text: &str) -> bool {
    let mut score = 0;
    let mut seen = [false; 9];
    let mut hit = |i: usize, weight: u32, seen: &mut [bool; 9]| {
        if !seen[i] {
            seen[i] = true;
            score += weight;
        }
    };
    if FRONT_MATTER.is_match(text) {
        hit(0, 3, &mut seen);
    }
    for line in text.lines() {
        if HEADING.is_match(line) {
            hit(1, 3, &mut seen);
        }
        if FENCE.is_match(line) {
            hit(2, 3, &mut seen);
        }
        if TABLE_RULE.is_match(line) {
            hit(3, 3, &mut seen);
        }
        if BULLET.is_match(line) {
            hit(4, 1, &mut seen);
        }
        if ORDERED.is_match(line) {
            hit(5, 1, &mut seen);
        }
        if QUOTE.is_match(line) {
            hit(6, 1, &mut seen);
        }
    }
    if STRONG.is_match(text) {
        hit(7, 2, &mut seen);
    }
    if LINK.is_match(text) || INLINE_CODE.is_match(text) {
        hit(8, 2, &mut seen);
    }
    score >= 3
}

pub struct Rendered {
    /// De html voor binnen `<body>`, met `data-dd-n` op elk genummerd blok.
    pub body: String,
    pub blocks: Vec<Block>,
    /// `title:` uit de front matter, anders de eerste kop van niveau 1.
    pub title: Option<String>,
    /// Begint het stuk zelf met een kop van niveau 1? Dan hoeft de app er geen titel boven te zetten.
    pub starts_with_title: bool,
}

struct Candidate {
    kind: &'static str,
    level: Option<u8>,
    text: String,
}

#[derive(PartialEq)]
enum Container {
    Item,
    Quote,
    Other,
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn safe_href(url: &str) -> Option<String> {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")).then(|| escape(url.trim()))
}

fn front_matter_title(yaml: &str) -> Option<String> {
    yaml.lines().find_map(|l| {
        let rest = l.strip_prefix("title:")?.trim();
        let t = rest.trim_matches(|c| c == '"' || c == '\'').trim();
        (!t.is_empty()).then(|| t.to_string())
    })
}

struct Renderer {
    html: String,
    cands: Vec<Candidate>,
    /// Open genummerde blokken; tekst gaat naar het binnenste.
    open: Vec<usize>,
    containers: Vec<Container>,
    quote_depth: usize,
    aligns: Vec<Alignment>,
    cell: usize,
    in_head: bool,
    in_meta: bool,
    meta: String,
}

impl Renderer {
    fn begin(&mut self, kind: &'static str, level: Option<u8>) -> String {
        self.cands.push(Candidate { kind, level, text: String::new() });
        let idx = self.cands.len() - 1;
        self.open.push(idx);
        format!("\u{1}{idx}\u{1}")
    }

    fn end(&mut self) {
        self.open.pop();
    }

    fn add_text(&mut self, s: &str) {
        if let Some(&i) = self.open.last() {
            self.cands[i].text.push_str(s);
        }
    }

    fn space(&mut self) {
        self.add_text(" ");
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => {
                if self.containers.last() == Some(&Container::Item) {
                    self.space();
                    self.html.push_str("<p>");
                } else {
                    let kind = if self.quote_depth > 0 { "quote" } else { "paragraph" };
                    let m = self.begin(kind, None);
                    self.html.push_str(&format!("<p{m}>"));
                }
            }
            Tag::Heading { level, .. } => {
                let lv = heading_level(level);
                let m = self.begin("heading", Some(lv));
                self.html.push_str(&format!("<h{lv}{m}>"));
            }
            Tag::BlockQuote(_) => {
                self.quote_depth += 1;
                self.containers.push(Container::Quote);
                self.html.push_str("<blockquote>");
            }
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().map(str::to_string).unwrap_or_default(),
                    CodeBlockKind::Indented => String::new(),
                };
                let m = self.begin("code", None);
                if lang.is_empty() {
                    self.html.push_str(&format!("<pre{m}><code>"));
                } else {
                    self.html.push_str(&format!("<pre{m} data-lang=\"{}\"><code>", escape(&lang)));
                }
            }
            Tag::HtmlBlock => {
                let kind = if self.quote_depth > 0 { "quote" } else { "paragraph" };
                let m = self.begin(kind, None);
                self.html.push_str(&format!("<p{m}>"));
            }
            Tag::List(Some(start)) if start != 1 => self.html.push_str(&format!("<ol start=\"{start}\">")),
            Tag::List(Some(_)) => self.html.push_str("<ol>"),
            Tag::List(None) => self.html.push_str("<ul>"),
            Tag::Item => {
                let m = self.begin("list-item", None);
                self.containers.push(Container::Item);
                self.html.push_str(&format!("<li{m}>"));
            }
            Tag::Table(aligns) => {
                self.aligns = aligns;
                self.containers.push(Container::Other);
                self.html.push_str("<div class=\"md-table\"><table>");
            }
            Tag::TableHead => {
                self.in_head = true;
                self.cell = 0;
                let m = self.begin("table-row", None);
                self.html.push_str(&format!("<thead><tr{m}>"));
            }
            Tag::TableRow => {
                self.cell = 0;
                let m = self.begin("table-row", None);
                self.html.push_str(&format!("<tr{m}>"));
            }
            Tag::TableCell => {
                if self.cell > 0 {
                    self.add_text(" | ");
                }
                let align = match self.aligns.get(self.cell) {
                    Some(Alignment::Left) => " style=\"text-align:left\"",
                    Some(Alignment::Center) => " style=\"text-align:center\"",
                    Some(Alignment::Right) => " style=\"text-align:right\"",
                    _ => "",
                };
                self.html.push_str(&format!("<{}{align}>", if self.in_head { "th" } else { "td" }));
            }
            Tag::Emphasis => self.html.push_str("<em>"),
            Tag::Strong => self.html.push_str("<strong>"),
            Tag::Strikethrough => self.html.push_str("<del>"),
            Tag::Link { dest_url, .. } => match safe_href(&dest_url) {
                Some(href) => self.html.push_str(&format!("<a href=\"{href}\" target=\"_blank\" rel=\"noopener noreferrer\">")),
                None => self.html.push_str("<a>"),
            },
            Tag::Image { .. } => self.html.push_str("<span class=\"md-img\">"),
            Tag::MetadataBlock(_) => self.in_meta = true,
            _ => {}
        }
    }

    fn stop(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => {
                self.html.push_str("</p>\n");
                if self.containers.last() != Some(&Container::Item) {
                    self.end();
                }
            }
            TagEnd::Heading(level) => {
                self.html.push_str(&format!("</h{}>\n", heading_level(level)));
                self.end();
            }
            TagEnd::BlockQuote(_) => {
                self.quote_depth -= 1;
                self.containers.pop();
                self.html.push_str("</blockquote>\n");
            }
            TagEnd::CodeBlock => {
                self.html.push_str("</code></pre>\n");
                self.end();
            }
            TagEnd::HtmlBlock => {
                self.html.push_str("</p>\n");
                self.end();
            }
            TagEnd::List(true) => self.html.push_str("</ol>\n"),
            TagEnd::List(false) => self.html.push_str("</ul>\n"),
            TagEnd::Item => {
                self.html.push_str("</li>\n");
                self.containers.pop();
                self.end();
            }
            TagEnd::Table => {
                self.containers.pop();
                self.html.push_str("</tbody></table></div>\n");
            }
            TagEnd::TableHead => {
                self.in_head = false;
                self.html.push_str("</tr></thead><tbody>\n");
                self.end();
            }
            TagEnd::TableRow => {
                self.html.push_str("</tr>\n");
                self.end();
            }
            TagEnd::TableCell => {
                self.html.push_str(if self.in_head { "</th>" } else { "</td>" });
                self.cell += 1;
            }
            TagEnd::Emphasis => self.html.push_str("</em>"),
            TagEnd::Strong => self.html.push_str("</strong>"),
            TagEnd::Strikethrough => self.html.push_str("</del>"),
            TagEnd::Link => self.html.push_str("</a>"),
            TagEnd::Image => self.html.push_str("</span>"),
            TagEnd::MetadataBlock(_) => self.in_meta = false,
            _ => {}
        }
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.stop(tag),
            Event::Text(t) if self.in_meta => self.meta.push_str(&t),
            Event::Text(t) => {
                self.html.push_str(&escape(&t));
                self.add_text(&t);
            }
            Event::Code(t) => {
                self.html.push_str(&format!("<code>{}</code>", escape(&t)));
                self.add_text(&t);
            }
            Event::Html(t) => {
                let text = TAG.replace_all(&t, " ");
                self.html.push_str(&escape(text.trim()));
                self.add_text(&text);
            }
            Event::InlineHtml(t) => {
                let tag = t.trim().to_ascii_lowercase();
                if tag.starts_with("<br") {
                    self.html.push_str("<br>");
                    self.space();
                }
            }
            Event::SoftBreak => {
                self.html.push('\n');
                self.space();
            }
            Event::HardBreak => {
                self.html.push_str("<br>\n");
                self.space();
            }
            Event::Rule => self.html.push_str("<hr>\n"),
            Event::TaskListMarker(checked) => {
                self.html.push_str(if checked { "<input type=\"checkbox\" disabled checked> " } else { "<input type=\"checkbox\" disabled> " });
                if let Some(&i) = self.open.last() {
                    self.cands[i].kind = "list-item";
                }
            }
            _ => {}
        }
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

pub fn render(text: &str) -> Rendered {
    let text = text.replace("\r\n", "\n");
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let mut r = Renderer {
        html: String::new(),
        cands: vec![],
        open: vec![],
        containers: vec![],
        quote_depth: 0,
        aligns: vec![],
        cell: 0,
        in_head: false,
        in_meta: false,
        meta: String::new(),
    };
    for event in Parser::new_ext(&text, options) {
        r.event(event);
    }

    // Alleen blokken met tekst krijgen een nummer, in leesvolgorde zonder gaten.
    let mut numbers = vec![None; r.cands.len()];
    let mut blocks = vec![];
    for (i, c) in r.cands.iter().enumerate() {
        let text = if c.kind == "code" { c.text.trim_matches('\n').to_string() } else { c.text.split_whitespace().collect::<Vec<_>>().join(" ") };
        if text.trim().is_empty() {
            continue;
        }
        let n = blocks.len() as u32 + 1;
        numbers[i] = Some(n);
        blocks.push(Block { n, kind: c.kind.into(), level: c.level, text, page: None, bbox: None });
    }
    let body = MARKER
        .replace_all(&r.html, |caps: &regex::Captures| {
            let i: usize = caps[1].parse().unwrap_or(usize::MAX);
            numbers.get(i).copied().flatten().map_or(String::new(), |n| format!(" data-dd-n=\"{n}\""))
        })
        .into_owned();

    let first_h1 = blocks.iter().find(|b| b.kind == "heading" && b.level == Some(1)).map(|b| b.text.clone());
    let starts_with_title = blocks.first().is_some_and(|b| b.kind == "heading" && b.level == Some(1));
    let title = front_matter_title(&r.meta).or(first_h1);
    Rendered { body, blocks, title, starts_with_title }
}

/// De opmaak van een markdownkopie: rustig en leesbaar, in de stijl van de andere geplakte tekst.
pub const CSS: &str = "\
body{max-width:40em;margin:3em auto;padding:0 1.5em;font:18px/1.65 Georgia,'Iowan Old Style',serif;color:#2b2620;background:#fff}\
h1,h2,h3,h4,h5,h6{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.25;margin:1.6em 0 .5em;color:#1d1a16}\
h1{font-size:1.75em;margin-top:0}h2{font-size:1.4em;padding-bottom:.25em;border-bottom:1px solid #e8e2d8}h3{font-size:1.18em}h4{font-size:1em}h5,h6{font-size:.9em;color:#5c544a}\
p{margin:0 0 1em}a{color:#8a4b14;text-decoration-color:rgba(138,75,20,.4);text-underline-offset:2px}\
ul,ol{margin:0 0 1em;padding-left:1.6em}li{margin:.25em 0}li>p{margin:.25em 0}li>ul,li>ol{margin:.25em 0}\
li:has(>input[type=checkbox]){list-style:none;margin-left:-1.3em}input[type=checkbox]{margin:0 .4em 0 0;vertical-align:middle}\
blockquote{margin:0 0 1em;padding:.2em 1em;border-left:4px solid #d9c7a8;color:#5c544a;background:#faf7f1}blockquote p{margin:.5em 0}\
code{font:.85em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f3efe8;padding:.1em .35em;border-radius:4px}\
pre{margin:0 0 1.2em;padding:.9em 1.1em;background:#f6f3ee;border:1px solid #e8e2d8;border-radius:8px;overflow:auto}pre code{background:none;padding:0;font-size:.82em;white-space:pre}\
hr{border:0;border-top:1px solid #e0d9cd;margin:2em 0}\
.md-table{overflow-x:auto;margin:0 0 1.2em}table{border-collapse:collapse;font-size:.9em;line-height:1.45}\
th,td{border:1px solid #e0d9cd;padding:.4em .7em;text-align:left;vertical-align:top}th{background:#f6f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600}\
tbody tr:nth-child(even){background:#fcfaf7}\
.md-img{color:#7a7065;font-style:italic}.md-img::before{content:'[afbeelding] '}\
del{color:#7a7065}img{max-width:100%}";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_markdown_but_not_plain_text() {
        assert!(looks_like_markdown("# Titel\n\nTekst"));
        assert!(looks_like_markdown("Intro\n\n```rust\nfn x() {}\n```"));
        assert!(looks_like_markdown("Een **belangrijk** punt\n\n- een\n- twee"));
        assert!(looks_like_markdown("| a | b |\n|---|---|\n| 1 | 2 |"));
        assert!(looks_like_markdown("---\ntitle: X\n---\nTekst"));
        assert!(!looks_like_markdown("Gewone tekst.\n\nNog een alinea met een #hashtag."));
        assert!(!looks_like_markdown("Boodschappen:\n- melk\n- brood\n1. eerst\n2. dan"));
        assert!(!looks_like_markdown("Hij zei: \"kom\".\n\nEn ging weg."));
    }

    #[test]
    fn blocks_are_numbered_and_match_the_html() {
        let r = render("# Titel\n\nEen *korte* alinea.\n\n- een\n- twee\n  - diep\n\n> Citaat\n\n```js\nlet a = 1;\n```\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n");
        let kinds: Vec<_> = r.blocks.iter().map(|b| (b.n, b.kind.as_str(), b.text.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (1, "heading", "Titel"),
                (2, "paragraph", "Een korte alinea."),
                (3, "list-item", "een"),
                (4, "list-item", "twee"),
                (5, "list-item", "diep"),
                (6, "quote", "Citaat"),
                (7, "code", "let a = 1;"),
                (8, "table-row", "A | B"),
                (9, "table-row", "1 | 2"),
            ]
        );
        assert!(r.starts_with_title);
        assert_eq!(r.title.as_deref(), Some("Titel"));
        assert!(r.body.contains("<h1 data-dd-n=\"1\">Titel</h1>"), "{}", r.body);
        assert!(r.body.contains("<p data-dd-n=\"2\">Een <em>korte</em> alinea.</p>"), "{}", r.body);
        assert!(r.body.contains("<pre data-dd-n=\"7\" data-lang=\"js\"><code>let a = 1;"), "{}", r.body);
        assert!(r.body.contains("<td style=\"text-align:right\">2</td>"), "{}", r.body);
        assert!(!r.body.contains('\u{1}'));
    }

    #[test]
    fn raw_html_and_unsafe_links_never_get_through() {
        let r = render("Klik [hier](javascript:alert(1)) of [daar](https://example.com).\n\n<script>alert(1)</script>\n\n<b>vet</b>");
        assert!(!r.body.contains("<script"), "{}", r.body);
        assert!(!r.body.contains("javascript:"), "{}", r.body);
        assert!(!r.body.contains("<b>"), "{}", r.body);
        assert!(r.body.contains("href=\"https://example.com\""), "{}", r.body);
    }

    #[test]
    fn front_matter_gives_the_title_and_is_not_shown() {
        let r = render("---\ntitle: \"Mijn stuk\"\ndate: 2024\n---\n\nTekst hier.");
        assert_eq!(r.title.as_deref(), Some("Mijn stuk"));
        assert!(!r.body.contains("date"), "{}", r.body);
        assert_eq!(r.blocks.len(), 1);
    }

    #[test]
    fn loose_list_items_with_nested_lists_keep_their_own_text() {
        let r = render("- eerste\n\n  meer\n\n  - binnen\n- tweede\n");
        let texts: Vec<_> = r.blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, vec!["eerste meer", "binnen", "tweede"]);
    }
}

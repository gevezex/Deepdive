//! Leest een structuur-antwoord terwijl het binnenkomt. Zodra een veld of blok compleet is, kan het op het scherm.
//! Dit is alleen voor het tonen: de gecontroleerde structuur vervangt het als het hele antwoord binnen is.

use serde_json::Value;

/// De velden die vóór het diagram staan. Wat hier niet in staat, komt pas mee met de hele structuur.
const EARLY_FIELDS: [&str; 5] = ["textKind", "goal", "message", "occasion", "summary"];

#[derive(Debug, Clone, PartialEq)]
pub enum Partial {
    Field { name: String, value: Value },
    Block(Value),
}

#[derive(Default)]
pub struct StructureStream {
    buf: String,
    pos: usize,
    started: bool,
    depth: u32,
    in_string: bool,
    escaped: bool,
    key_start: Option<usize>,
    key: Option<String>,
    value_start: Option<usize>,
    block_start: Option<usize>,
}

impl StructureStream {
    pub fn feed(&mut self, text: &str) -> Vec<Partial> {
        self.buf.push_str(text);
        let mut out = vec![];
        if !self.started && !self.find_start() {
            return out;
        }
        // Alle tekens waar het hier om gaat zijn ascii, dus bytes lezen kan niet midden in een letter stoppen.
        let mut i = self.pos;
        while i < self.buf.len() {
            let b = self.buf.as_bytes()[i];
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'"' {
                    self.in_string = false;
                    if self.depth == 1 {
                        if let Some(start) = self.key_start.take() {
                            self.key = Some(self.buf[start + 1..i].to_string());
                        } else if let Some(start) = self.value_start {
                            out.extend(self.field(&self.buf[start..=i]));
                            self.clear_value();
                        }
                    }
                }
                i += 1;
                continue;
            }
            match b {
                b'"' => {
                    self.in_string = true;
                    if self.depth == 1 {
                        if self.key.is_none() {
                            self.key_start = Some(i);
                        } else if self.value_start.is_none() {
                            self.value_start = Some(i);
                        }
                    }
                }
                b'{' | b'[' => {
                    if self.depth == 1 && self.value_start.is_none() {
                        self.value_start = Some(i);
                    }
                    if self.depth == 2 && b == b'{' && self.key.as_deref() == Some("blocks") {
                        self.block_start = Some(i);
                    }
                    self.depth += 1;
                }
                b'}' | b']' => {
                    if self.depth == 1 {
                        // Het hele object is af. Een laatste kaal veld (null, een getal) eindigt hier.
                        out.extend(self.scalar(i));
                    }
                    self.depth = self.depth.saturating_sub(1);
                    if self.depth == 2 {
                        if let Some(start) = self.block_start.take() {
                            if let Ok(value) = serde_json::from_str(&self.buf[start..=i]) {
                                out.push(Partial::Block(value));
                            }
                        }
                    }
                    if self.depth == 1 {
                        if let Some(start) = self.value_start {
                            out.extend(self.field(&self.buf[start..=i]));
                        }
                        self.clear_value();
                    }
                }
                b',' if self.depth == 1 => {
                    out.extend(self.scalar(i));
                    self.clear_value();
                }
                b':' | b' ' | b'\n' | b'\r' | b'\t' => {}
                _ => {
                    if self.depth == 1 && self.key.is_some() && self.value_start.is_none() {
                        self.value_start = Some(i);
                    }
                }
            }
            i += 1;
        }
        self.pos = i;
        out
    }

    /// Slaat denkstappen, tekst ervoor en een codeblok over. Geeft terug of het JSON-object is begonnen.
    fn find_start(&mut self) -> bool {
        let from = self.buf.rfind("</think>").map_or(0, |at| at + "</think>".len());
        let body = &self.buf[from..];
        let opening = body.trim_start();
        if self.buf[..from].is_empty() && (opening.starts_with("<think>") || "<think>".starts_with(opening)) {
            return false;
        }
        let Some(start) = body.find('{') else { return false };
        self.pos = from + start + 1;
        self.started = true;
        self.depth = 1;
        true
    }

    fn scalar(&self, end: usize) -> Option<Partial> {
        let start = self.value_start?;
        self.field(self.buf[start..end].trim())
    }

    fn field(&self, raw: &str) -> Option<Partial> {
        let name = self.key.as_deref()?;
        if !EARLY_FIELDS.contains(&name) {
            return None;
        }
        Some(Partial::Field { name: name.to_string(), value: serde_json::from_str(raw).ok()? })
    }

    fn clear_value(&mut self) {
        self.key = None;
        self.value_start = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ANSWER: &str = r#"{"textKind":"news","goal":{"main":{"kind":"persuade","description":"Over \"x\" {}"},"secondary":[]},"message":"Één zin, met komma.","occasion":null,"summary":"Kort.","articleParagraphs":[1,4],"blocks":[{"id":"b1","paragraphs":[[1,2]]},{"id":"b2","paragraphs":[[3,4]]}],"relations":[]}"#;

    fn names(parts: &[Partial]) -> Vec<String> {
        parts.iter().map(|p| match p {
            Partial::Field { name, .. } => name.clone(),
            Partial::Block(v) => v["id"].as_str().unwrap().to_string(),
        }).collect()
    }

    #[test]
    fn velden_komen_in_volgorde_ook_bij_losse_stukjes() {
        let chars: Vec<char> = ANSWER.chars().collect();
        for size in [1, 2, 7, chars.len()] {
            let mut stream = StructureStream::default();
            let mut parts = vec![];
            for chunk in chars.chunks(size) {
                parts.extend(stream.feed(&chunk.iter().collect::<String>()));
            }
            assert_eq!(names(&parts), ["textKind", "goal", "message", "occasion", "summary", "b1", "b2"], "stukjes van {size}");
            assert_eq!(parts[2], Partial::Field { name: "message".into(), value: json!("Één zin, met komma.") });
            assert_eq!(parts[3], Partial::Field { name: "occasion".into(), value: json!(null) });
        }
    }

    #[test]
    fn de_boodschap_is_er_voordat_de_rest_binnen_is() {
        let mut stream = StructureStream::default();
        let cut = ANSWER.find("\"summary\"").unwrap();
        assert!(names(&stream.feed(&ANSWER[..cut])).contains(&"message".to_string()));
    }

    #[test]
    fn denkstappen_en_tekst_ervoor_worden_overgeslagen() {
        let mut stream = StructureStream::default();
        let mut parts = stream.feed("<think>misschien {\"message\":\"nee\"}");
        parts.extend(stream.feed("</think>Hier is het:\n```json\n"));
        parts.extend(stream.feed(r#"{"message":"ja","blocks":[{"id":"b1"}]}"#));
        assert_eq!(names(&parts), ["message", "b1"]);
        assert_eq!(parts[0], Partial::Field { name: "message".into(), value: json!("ja") });
    }

    #[test]
    fn onzin_geeft_geen_paniek() {
        let mut stream = StructureStream::default();
        assert!(stream.feed("geen json").is_empty());
        let mut stream = StructureStream::default();
        let parts = stream.feed(r#"{"message": kapot, "blocks":[{"id":}]}"#);
        assert!(parts.is_empty(), "{parts:?}");
    }
}

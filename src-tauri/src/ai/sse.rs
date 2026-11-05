//! Server-sent events, stukje voor stukje. Een netwerkblok kan midden in een regel of een letter eindigen.

const MAX_BUFFER: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Event {
    pub name: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct Parser {
    buffer: Vec<u8>,
    name: Option<String>,
    data: Vec<String>,
}

impl Parser {
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Event>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut events = vec![];
        let mut start = 0;
        while let Some(pos) = self.buffer[start..].iter().position(|b| *b == b'\n') {
            let end = start + pos;
            let line = String::from_utf8_lossy(&self.buffer[start..end]).trim_end_matches('\r').to_string();
            start = end + 1;
            if let Some(event) = self.line(&line) {
                events.push(event);
            }
        }
        self.buffer.drain(..start);
        if self.buffer.len() > MAX_BUFFER {
            return Err("Eén regel in de stream is onredelijk lang.".into());
        }
        Ok(events)
    }

    /// Een laatste bericht zonder afsluitende lege regel telt ook mee.
    pub fn finish(&mut self) -> Option<Event> {
        if !self.buffer.is_empty() {
            let line = String::from_utf8_lossy(&std::mem::take(&mut self.buffer)).trim_end_matches('\r').to_string();
            self.line(&line);
        }
        self.dispatch()
    }

    fn line(&mut self, line: &str) -> Option<Event> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').map_or((line, ""), |(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)));
        match field {
            "event" => self.name = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<Event> {
        let name = self.name.take();
        if self.data.is_empty() {
            return None;
        }
        Some(Event { name, data: std::mem::take(&mut self.data).join("\n") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_chunks_split_anywhere() {
        let text = "event: a\r\ndata: één\n\n: opmerking\n\ndata: x\ndata: y\n\ndata:z\n\n";
        for size in 1..text.len() {
            let mut parser = Parser::default();
            let events: Vec<Event> = text.as_bytes().chunks(size).flat_map(|c| parser.feed(c).unwrap()).collect();
            assert_eq!(
                events,
                vec![
                    Event { name: Some("a".into()), data: "één".into() },
                    Event { name: None, data: "x\ny".into() },
                    Event { name: None, data: "z".into() },
                ],
                "blokgrootte {size}"
            );
        }
    }

    #[test]
    fn keeps_last_event_without_blank_line() {
        let mut parser = Parser::default();
        assert!(parser.feed(b"data: laatste").unwrap().is_empty());
        assert_eq!(parser.finish().unwrap().data, "laatste");
    }
}

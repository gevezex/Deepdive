//! Het gezamenlijke bronmodel. Website, pdf en geplakte tekst leggen hun tekst op dezelfde manier vast:
//! als blokken met een vast nummer `n`. Latere stappen (blauwdruk, ¶-verwijzingen) steunen hierop.

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Web,
    Pdf,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    /// Vast alineanummer, oplopend vanaf 1. Verandert nooit nadat de bron is opgeslagen.
    pub n: u32,
    /// heading, paragraph, list-item, quote, code, caption of table-row.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    pub text: String,
    /// Alleen bij pdf: paginanummer vanaf 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    /// Alleen bij pdf: [x0, y0, x1, y1] in pdf-eenheden.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f32; 4]>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStats {
    pub saved: u32,
    pub failed: u32,
    pub bytes: u64,
    /// De eerste mislukte adressen, om problemen te kunnen uitzoeken.
    pub failed_urls: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletenessVerdict {
    Complete,
    LikelyIncomplete,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletenessSignal {
    pub key: String,
    /// Positief wijst op onvolledig, negatief op volledig.
    pub weight: i32,
    pub detail: String,
}

/// Is dit het hele stuk? De blauwdruk leest dit uit: een blauwdruk van een half artikel zou misleidend zijn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completeness {
    pub verdict: CompletenessVerdict,
    /// Voor de lezer, in gewone taal.
    pub reason: String,
    pub signals: Vec<CompletenessSignal>,
    /// De lezer koos "Toch gebruiken". Het oordeel zelf blijft staan.
    pub accepted_by_user: bool,
}

impl Default for Completeness {
    /// Bronnen die zijn opgeslagen voordat de app dit controleerde.
    fn default() -> Self {
        Self { verdict: CompletenessVerdict::Unknown, reason: "Deze kopie is opgeslagen voordat de app dit controleerde.".into(), signals: vec![], accepted_by_user: false }
    }
}

impl Completeness {
    pub fn plain(verdict: CompletenessVerdict, reason: &str) -> Self {
        Self { verdict, reason: reason.into(), signals: vec![], accepted_by_user: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub schema_version: u32,
    pub id: String,
    pub kind: SourceKind,
    pub title: String,
    /// Het adres zoals opgegeven, als dat er is.
    pub url: Option<String>,
    /// Het adres na doorverwijzingen.
    pub final_url: Option<String>,
    pub captured_at: String,
    pub author: Option<String>,
    pub site_name: Option<String>,
    pub published: Option<String>,
    pub lang: Option<String>,
    /// Bij pdf: sha-256 van het bestand, om dubbele kopieën te herkennen.
    pub content_hash: Option<String>,
    pub page_count: Option<u32>,
    /// False zolang de tekst van een pdf nog niet is uitgelezen.
    pub text_ready: bool,
    pub blocks: Vec<Block>,
    pub word_count: u32,
    pub assets: AssetStats,
    /// Meldingen voor de lezer, bijvoorbeeld "mogelijk onvolledig".
    pub warnings: Vec<String>,
    #[serde(default)]
    pub completeness: Completeness,
    /// Met een bewaarde sessie opgehaald. De kopie kan dan persoonsgegevens bevatten.
    #[serde(default)]
    pub fetched_with_session: bool,
    /// De kopie die deze heeft vervangen. Zo'n bron blijft bewaard maar staat niet meer in de lijst.
    /// Een kopie is nooit aangepast: opnieuw ophalen maakt altijd een nieuwe bron met eigen alineanummers.
    #[serde(default)]
    pub superseded_by: Option<String>,
    /// De kopie die deze heeft vervangen, of waarvoor deze klaarstaat zolang de lezer nog moet kiezen.
    #[serde(default)]
    pub previous_id: Option<String>,
}

/// Korte vorm voor de bronnenlijst.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub id: String,
    pub kind: SourceKind,
    pub title: String,
    pub url: Option<String>,
    pub captured_at: String,
    pub word_count: u32,
}

pub fn word_count(blocks: &[Block]) -> u32 {
    blocks.iter().map(|b| b.text.split_whitespace().count() as u32).sum()
}

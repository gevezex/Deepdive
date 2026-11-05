//! De blauwdruk als data: lagen 1 tot en met 3 uit VISIE.md. Dit is ook de vorm die het model moet teruggeven;
//! velden die alleen de app invult staan in `Blueprint` en `SourceStatus`.

use crate::model::CompletenessVerdict;
use serde::{Deserialize, Serialize};

/// Omhoog bij elke wijziging die een eerder opgeslagen blauwdruk onleesbaar of anders van betekenis maakt.
pub const SCHEMA_VERSION: u32 = 2;

/// Omhoog bij elke inhoudelijke wijziging van de opdrachten in `prompts/`. Een blauwdruk wordt per bron, model en
/// promptversie bewaard, dus een nieuwe versie overschrijft niets.
pub const PROMPT_VERSION: u32 = 2;

/// Eerste en laatste alineanummer, allebei inbegrepen. In JSON: `[3, 5]`.
pub type ParagraphRange = (u32, u32);

/// Modellen schrijven één alinea vaak als `[3]` of `3`. De betekenis is dan duidelijk, dus dat is geen fout.
fn ranges<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<ParagraphRange>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Item {
        One(u32),
        Pair((u32, u32)),
        Single((u32,)),
    }
    Ok(Vec::<Item>::deserialize(d)?
        .into_iter()
        .map(|item| match item {
            Item::One(n) | Item::Single((n,)) => (n, n),
            Item::Pair(pair) => pair,
        })
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextKind {
    News,
    Opinion,
    Research,
    Memoir,
    Essay,
    Explainer,
    Review,
    Reference,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalKind {
    ExplainProblem,
    OfferSolution,
    VentFrustration,
    PersonalExperience,
    DevelopConcept,
    Persuade,
    ReportResearch,
    ReportEvent,
    Refute,
    Evaluate,
    Instruct,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Goal {
    pub kind: GoalKind,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Goals {
    pub main: Goal,
    #[serde(default)]
    pub secondary: Vec<Goal>,
}

/// Staat het letterlijk in de tekst, of leidt het model het af?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Stated,
    Inferred,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occasion {
    pub text: String,
    pub origin: Origin,
    #[serde(default, deserialize_with = "ranges")]
    pub paragraphs: Vec<ParagraphRange>,
}

/// Een citaat in de oorspronkelijke taal. `verified` zet alleen de controle in de app, nooit het model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quote {
    pub paragraph: u32,
    pub text: String,
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockRole {
    Occasion,
    Thesis,
    Concept,
    Explanation,
    Argument,
    Evidence,
    Example,
    Objection,
    Rebuttal,
    Conclusion,
    Question,
    Method,
    Results,
    Interpretation,
    Limitation,
    Event,
    Background,
    Reaction,
    Reflection,
    Lesson,
    Instruction,
    Assessment,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub role: BlockRole,
    pub title: String,
    pub content: String,
    #[serde(deserialize_with = "ranges")]
    pub paragraphs: Vec<ParagraphRange>,
    #[serde(default)]
    pub quote: Option<Quote>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    BuildsOn,
    EvidenceFor,
    ExampleOf,
    Answers,
    Contrasts,
    FollowsInTime,
    Concludes,
}

/// `block` steunt op `depends_on`. De pijl in het diagram loopt van `depends_on` naar `block`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub block: String,
    pub depends_on: String,
    pub kind: RelationKind,
    pub explanation: String,
}

/// Laag 1 en 2, in de volgorde waarin het model ze moet schrijven: wat vooraan staat kan de app eerder tonen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Structure {
    pub text_kind: TextKind,
    pub goal: Goals,
    pub message: String,
    /// Mag ontbreken: niet elk stuk maakt duidelijk waarom het is geschreven.
    #[serde(default)]
    pub occasion: Option<Occasion>,
    pub summary: String,
    /// Waar het eigenlijke stuk staat, dus zonder menu's, voetteksten en bronnenlijst.
    pub article_paragraphs: ParagraphRange,
    pub blocks: Vec<Block>,
    #[serde(default)]
    pub relations: Vec<Relation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Assumption,
    Leap,
    Gap,
    Evidence,
    Missing,
    HeadlineVsContent,
}

impl Category {
    pub const ALL: [Category; 6] = [Self::Assumption, Self::Leap, Self::Gap, Self::Evidence, Self::Missing, Self::HeadlineVsContent];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Certainty {
    High,
    Medium,
    Low,
}

/// Maakt een punt het betoog zwakker of juist sterker? Zo lijkt lof op het scherm niet op een gebrek.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Polarity {
    Minus,
    Plus,
}

/// Alleen bij `Category::Evidence`: wat voor bewijs de auteur geeft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Study,
    Data,
    Expert,
    Anecdote,
    Assertion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub id: String,
    pub category: Category,
    pub polarity: Polarity,
    pub origin: Origin,
    pub certainty: Certainty,
    /// Het id van een blok of relatie. `None` als het model verwees naar iets dat niet bestaat.
    pub anchor: Option<String>,
    pub claim: String,
    pub explanation: String,
    #[serde(deserialize_with = "ranges")]
    pub paragraphs: Vec<ParagraphRange>,
    #[serde(default)]
    pub quotes: Vec<Quote>,
    #[serde(default)]
    pub evidence_kind: Option<EvidenceKind>,
    /// Te veel alinea's om na te zoeken. Zet alleen de controle in de app, nooit het model.
    #[serde(default)]
    pub broad: bool,
}

/// Een begrip dat de lezer nodig heeft en dat de tekst niet uitlegt. Hulp, geen kritiek: telt niet als punt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Term {
    pub term: String,
    pub explanation: String,
    #[serde(default, deserialize_with = "ranges")]
    pub paragraphs: Vec<ParagraphRange>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckResult {
    Found,
    NothingFound,
    NotApplicable,
}

/// Per onderdeel wat de kritische blik opleverde. Zo is "geen gat gevonden" een uitkomst en geen ontbrekend veld.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCheck {
    pub category: Category,
    pub result: CheckResult,
    #[serde(default)]
    pub note: Option<String>,
}

/// Laag 3. Een lege `points` is een geldige uitkomst.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Critique {
    pub points: Vec<Point>,
    #[serde(default)]
    pub terms: Vec<Term>,
    pub checked: Vec<CategoryCheck>,
    pub overall: String,
}

/// Wat de app over de bron weet. Een waarschijnlijk onvolledig stuk houdt die status in het resultaat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source_id: String,
    pub completeness: CompletenessVerdict,
    pub likely_incomplete: bool,
    pub accepted_by_user: bool,
    /// Voor de lezer. Alleen gevuld als de bron waarschijnlijk onvolledig is.
    pub warning: Option<String>,
    pub block_count: u32,
    pub word_count: u32,
}

/// Wat de controle heeft hersteld of gemarkeerd. Elke afwijking staat hier; niets verdwijnt stilletjes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: String,
    pub path: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteStats {
    pub total: u32,
    /// Staat in de opgegeven alinea, op leestekens en witruimte na gelijk.
    pub verified: u32,
    /// Staat wel in de bron, maar in een andere alinea. De verwijzing is verbeterd.
    pub moved: u32,
    /// Staat niet in de bron en is weggehaald.
    pub removed: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    pub quotes: QuoteStats,
    /// Deel van de alinea's van het eigenlijke stuk dat in een blok valt, van 0 tot 1.
    pub coverage: f32,
    pub relations_removed: u32,
    pub ranges_fixed: u32,
    pub anchors_removed: u32,
    /// Punten die naar te veel alinea's wijzen om na te zoeken.
    #[serde(default)]
    pub broad_points: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blueprint {
    pub schema_version: u32,
    pub source: SourceStatus,
    /// Herkomst zichtbaar: welk model deze blauwdruk maakte.
    pub model: String,
    /// Samen met `model` en `prompt_version` de sleutel waaronder deze blauwdruk bewaard is.
    pub provider_id: String,
    pub prompt_version: u32,
    pub language: String,
    pub created_at: String,
    /// Hoe lang het maken duurde.
    pub seconds: f32,
    #[serde(flatten)]
    pub structure: Structure,
    /// `None` als alleen de kritische laag mislukte: doel en diagram blijven dan bruikbaar.
    pub critique: Option<Critique>,
    pub issues: Vec<Issue>,
    pub checks: Checks,
}

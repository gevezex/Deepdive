//! Vangt waarden op die niet in de vaste lijsten staan, vóór het lezen van het antwoord. Eén afwijkend woord is geen
//! reden om een verder bruikbaar antwoord weg te gooien. Elke ingreep komt als `Issue` bij de blauwdruk. Wat ontbreekt
//! of geen tekst is, blijft een echte fout: dan krijgt het model een herkansing.

use super::schema::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

fn is_valid<T: DeserializeOwned>(value: &str) -> bool {
    serde_json::from_value::<T>(json!(value)).is_ok()
}

/// Wat het model zei, kort genoeg voor een melding.
fn shown(value: &str) -> String {
    value.chars().take(40).collect()
}

/// Kijkt of de waarde klopt. Alleen hoofdletters of streepjes anders is geen afwijking en wordt stil gelijkgetrokken.
/// Geeft de oorspronkelijke tekst terug als de waarde echt onbekend is.
fn unknown<T: DeserializeOwned>(slot: Option<&mut Value>) -> Option<String> {
    let slot = slot?;
    let text = slot.as_str()?.to_string();
    if is_valid::<T>(&text) {
        return None;
    }
    let normal = text.trim().to_lowercase().replace([' ', '-'], "_");
    if is_valid::<T>(&normal) {
        *slot = json!(normal);
        return None;
    }
    Some(text)
}

/// The name of a field, as the reader sees it in a message: English, Dutch, Turkish.
type What = [&'static str; 3];

fn name(what: What) -> String {
    let [en, nl, tr] = what;
    crate::i18n::tr(en, nl, tr)
}

const TEXT_KIND: What = ["text type", "soort tekst", "metin türü"];
const GOAL: What = ["goal", "doel", "amaç"];
const ROLE: What = ["role", "rol", "rol"];
const CATEGORY: What = ["category", "categorie", "kategori"];
const POLARITY: What = ["plus or minus", "plus of min", "artı ya da eksi"];
const ORIGIN: What = ["origin", "herkomst", "köken"];
const CERTAINTY: What = ["certainty", "zekerheid", "kesinlik"];

fn to_other<T: DeserializeOwned>(slot: Option<&mut Value>, what: What, path: String, issues: &mut Vec<Issue>) {
    let Some(slot) = slot else { return };
    if let Some(text) = unknown::<T>(Some(&mut *slot)) {
        *slot = json!("other");
        issues.push(Issue { code: "value_replaced".into(), path, detail: replaced_by_other(what, &text) });
    }
}

fn replaced_by_other(what: What, text: &str) -> String {
    let (what, text) = (name(what), shown(text));
    tr_fmt!(
        "The model gave {what} \"{text}\". The app does not know that value, so it now says \"other\".",
        "Het model gaf {what} \"{text}\". Die kent de app niet, dus staat hier nu \"overig\".",
        "Model {what} için \"{text}\" değerini verdi. Uygulama bu değeri tanımıyor, bu yüzden burada artık \"diğer\" yazıyor.",
    )
}

/// Haalt elementen weg waarvoor `bad` een reden geeft.
fn drop_items(list: Option<&mut Value>, mut bad: impl FnMut(&mut Value) -> Option<String>, code: &str, path: &str, issues: &mut Vec<Issue>) {
    let Some(items) = list.and_then(Value::as_array_mut) else { return };
    let mut kept = Vec::with_capacity(items.len());
    for mut item in std::mem::take(items) {
        match bad(&mut item) {
            Some(detail) => {
                let id = item.get("id").and_then(Value::as_str).map(shown);
                let path = id.map_or_else(|| path.to_string(), |id| format!("{path}.{id}"));
                issues.push(Issue { code: code.into(), path, detail });
            }
            None => kept.push(item),
        }
    }
    *items = kept;
}

pub fn repair_structure(value: &mut Value) -> Vec<Issue> {
    let mut issues = vec![];
    to_other::<TextKind>(value.get_mut("textKind"), TEXT_KIND, "textKind".into(), &mut issues);
    if let Some(goal) = value.get_mut("goal") {
        to_other::<GoalKind>(goal.pointer_mut("/main/kind"), GOAL, "goal.main".into(), &mut issues);
        if let Some(list) = goal.get_mut("secondary").and_then(Value::as_array_mut) {
            for (i, item) in list.iter_mut().enumerate() {
                to_other::<GoalKind>(item.get_mut("kind"), GOAL, format!("goal.secondary.{i}"), &mut issues);
            }
        }
    }
    // Zonder te weten of de auteur het zelf zegt, is het de lezing van het model.
    if let Some(origin) = value.pointer_mut("/occasion/origin") {
        if let Some(text) = unknown::<Origin>(Some(&mut *origin)) {
            *origin = json!("inferred");
            issues.push(Issue { code: "value_replaced".into(), path: "occasion".into(), detail: {
                let text = shown(&text);
                tr_fmt!(
                    "The model gave origin \"{text}\". The app does not know that value, so the occasion is now marked as inferred.",
                    "Het model gaf herkomst \"{text}\". Die kent de app niet, dus staat de aanleiding nu als afgeleid.",
                    "Model köken için \"{text}\" değerini verdi. Uygulama bu değeri tanımıyor, bu yüzden vesile artık çıkarım olarak işaretlendi.",
                )
            } });
        }
    }
    if let Some(blocks) = value.get_mut("blocks").and_then(Value::as_array_mut) {
        for (i, block) in blocks.iter_mut().enumerate() {
            let id = block.get("id").and_then(Value::as_str).map_or_else(|| i.to_string(), shown);
            to_other::<BlockRole>(block.get_mut("role"), ROLE, format!("blocks.{id}"), &mut issues);
        }
    }
    drop_items(
        value.get_mut("relations"),
        |relation| unknown::<RelationKind>(relation.get_mut("kind")).map(|text| {
            let text = shown(&text);
            tr_fmt!(
                "The model gave relation \"{text}\". The app does not know that value, so this arrow was removed.",
                "Het model gaf relatie \"{text}\". Die kent de app niet, dus is deze pijl weggehaald.",
                "Model ilişki için \"{text}\" değerini verdi. Uygulama bu değeri tanımıyor, bu yüzden bu ok kaldırıldı.",
            )
        }),
        "relation_removed",
        "relations",
        &mut issues,
    );
    issues
}

pub fn repair_critique(value: &mut Value) -> Vec<Issue> {
    let mut issues = vec![];
    drop_items(
        value.get_mut("points"),
        |point| {
            let found = unknown::<Category>(point.get_mut("category")).map(|t| (CATEGORY, t))
                .or_else(|| unknown::<Polarity>(point.get_mut("polarity")).map(|t| (POLARITY, t)))
                .or_else(|| unknown::<Origin>(point.get_mut("origin")).map(|t| (ORIGIN, t)))
                .or_else(|| unknown::<Certainty>(point.get_mut("certainty")).map(|t| (CERTAINTY, t)));
            found.map(|(what, text)| {
                let (what, text) = (name(what), shown(&text));
                tr_fmt!(
                    "The model gave {what} \"{text}\". The app does not know that value, so this point was removed.",
                    "Het model gaf {what} \"{text}\". Die kent de app niet, dus is dit punt weggehaald.",
                    "Model {what} için \"{text}\" değerini verdi. Uygulama bu değeri tanımıyor, bu yüzden bu nokta kaldırıldı.",
                )
            })
        },
        "point_removed",
        "points",
        &mut issues,
    );
    if let Some(points) = value.get_mut("points").and_then(Value::as_array_mut) {
        for point in points {
            let id = point.get("id").and_then(Value::as_str).map_or_else(String::new, shown);
            if let Some(slot) = point.get_mut("evidenceKind") {
                if let Some(text) = unknown::<EvidenceKind>(Some(&mut *slot)) {
                    *slot = Value::Null;
                    issues.push(Issue { code: "value_replaced".into(), path: format!("points.{id}"), detail: {
                        let text = shown(&text);
                        tr_fmt!(
                            "The model gave evidence type \"{text}\". The app does not know that value, so it was left out.",
                            "Het model gaf soort bewijs \"{text}\". Die kent de app niet, dus is die weggelaten.",
                            "Model kanıt türü için \"{text}\" değerini verdi. Uygulama bu değeri tanımıyor, bu yüzden dışarıda bırakıldı.",
                        )
                    } });
                }
            }
        }
    }
    drop_items(
        value.get_mut("checked"),
        |check| {
            let found = unknown::<Category>(check.get_mut("category")).or_else(|| unknown::<CheckResult>(check.get_mut("result")));
            found.map(|text| {
                let text = shown(&text);
                tr_fmt!(
                    "The model gave \"{text}\" in the per-category list. The app does not know that value, so that line was removed.",
                    "Het model gaf \"{text}\" in de lijst per onderdeel. Die kent de app niet, dus is die regel weggehaald.",
                    "Model kategori listesinde \"{text}\" değerini verdi. Uygulama bu değeri tanımıyor, bu yüzden o satır kaldırıldı.",
                )
            })
        },
        "check_removed",
        "checked",
        &mut issues,
    );
    issues
}

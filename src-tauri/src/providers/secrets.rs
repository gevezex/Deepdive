//! Bewaarplek voor API-sleutels. In de app is dat de sleutelhanger van het besturingssysteem.

use crate::ai::ApiKey;
use crate::error::AppError;
use std::collections::HashMap;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<ApiKey>, AppError>;
    /// Als `get`, maar leest altijd opnieuw uit de bewaarplek. Voor als een andere kopie van de app het item kan hebben vervangen.
    fn get_fresh(&self, account: &str) -> Result<Option<ApiKey>, AppError> {
        self.get(account)
    }
    fn set(&self, account: &str, key: &ApiKey) -> Result<(), AppError>;
    /// Geen fout als de sleutel er al niet meer is.
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new(service: impl Into<String>) -> Self {
        Self { service: service.into() }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(&self.service, account).map_err(failed)
    }
}

/// De tekst van `keyring` bevat nooit de waarde van de sleutel.
fn failed(e: keyring::Error) -> AppError {
    AppError::new("keychain", "De sleutelhanger van deze computer gaf een fout. Probeer het opnieuw; sta de toegang toe als macOS erom vraagt.").with_detail(e.to_string())
}

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<ApiKey>, AppError> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(ApiKey::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(failed(e)),
        }
    }

    fn set(&self, account: &str, key: &ApiKey) -> Result<(), AppError> {
        self.entry(account)?.set_password(key.expose()).map_err(failed)
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(failed(e)),
        }
    }
}

/// Leest elke sleutel hooguit één keer per sessie uit de sleutelhanger. Bij een build zonder vaste handtekening vraagt
/// macOS bij elke lezing om toestemming; zo gebeurt dat één keer per item in plaats van bij elke aanroep van een model.
/// Alleen wat is gevonden blijft bewaard, in het geheugen van dit proces en niet langer dan de app draait.
pub struct CachedSecrets<S> {
    inner: S,
    seen: Mutex<HashMap<String, ApiKey>>,
}

impl<S: SecretStore> CachedSecrets<S> {
    pub fn new(inner: S) -> Self {
        Self { inner, seen: Mutex::new(HashMap::new()) }
    }
}

impl<S: SecretStore> SecretStore for CachedSecrets<S> {
    fn get(&self, account: &str) -> Result<Option<ApiKey>, AppError> {
        // Het slot blijft vast tijdens het lezen, zodat twee aanroepen tegelijk maar één melding geven.
        let mut seen = self.seen.lock().unwrap();
        if let Some(key) = seen.get(account) {
            return Ok(Some(key.clone()));
        }
        let key = self.inner.get(account)?;
        if let Some(key) = &key {
            seen.insert(account.to_string(), key.clone());
        }
        Ok(key)
    }

    fn get_fresh(&self, account: &str) -> Result<Option<ApiKey>, AppError> {
        let mut seen = self.seen.lock().unwrap();
        let key = self.inner.get(account)?;
        match &key {
            Some(key) => seen.insert(account.to_string(), key.clone()),
            None => seen.remove(account),
        };
        Ok(key)
    }

    fn set(&self, account: &str, key: &ApiKey) -> Result<(), AppError> {
        let mut seen = self.seen.lock().unwrap();
        self.inner.set(account, key)?;
        seen.insert(account.to_string(), key.clone());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        let mut seen = self.seen.lock().unwrap();
        self.inner.delete(account)?;
        seen.remove(account);
        Ok(())
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemorySecrets(pub std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<Option<ApiKey>, AppError> {
        Ok(self.0.lock().unwrap().get(account).map(ApiKey::new))
    }
    fn set(&self, account: &str, key: &ApiKey) -> Result<(), AppError> {
        self.0.lock().unwrap().insert(account.to_string(), key.expose().to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), AppError> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Telt hoe vaak de bewaarplek echt wordt gelezen.
    #[derive(Default)]
    struct Counting {
        inner: MemorySecrets,
        reads: std::sync::atomic::AtomicU32,
    }

    impl SecretStore for Counting {
        fn get(&self, account: &str) -> Result<Option<ApiKey>, AppError> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.get(account)
        }
        fn set(&self, account: &str, key: &ApiKey) -> Result<(), AppError> {
            self.inner.set(account, key)
        }
        fn delete(&self, account: &str) -> Result<(), AppError> {
            self.inner.delete(account)
        }
    }

    fn reads(c: &CachedSecrets<Counting>) -> u32 {
        c.inner.reads.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn sleutel_wordt_een_keer_per_sessie_gelezen() {
        let c = CachedSecrets::new(Counting::default());
        c.inner.inner.set("a", &ApiKey::new("een")).unwrap();
        for _ in 0..5 {
            assert_eq!(c.get("a").unwrap().unwrap().expose(), "een");
        }
        assert_eq!(reads(&c), 1);
    }

    #[test]
    fn nieuwe_of_gewiste_sleutel_is_meteen_zichtbaar() {
        let c = CachedSecrets::new(Counting::default());
        c.set("a", &ApiKey::new("een")).unwrap();
        assert_eq!(c.get("a").unwrap().unwrap().expose(), "een");
        assert_eq!(reads(&c), 0, "wat net is opgeslagen hoeft niet gelezen");
        c.set("a", &ApiKey::new("twee")).unwrap();
        assert_eq!(c.get("a").unwrap().unwrap().expose(), "twee");
        c.delete("a").unwrap();
        assert!(c.get("a").unwrap().is_none());
    }

    #[test]
    fn ontbrekende_sleutel_blijft_niet_hangen_en_opnieuw_lezen_kan() {
        let c = CachedSecrets::new(Counting::default());
        assert!(c.get("a").unwrap().is_none());
        c.inner.inner.set("a", &ApiKey::new("van een andere kopie")).unwrap();
        assert!(c.get("a").unwrap().is_some());
        c.inner.inner.set("a", &ApiKey::new("nieuw")).unwrap();
        assert_eq!(c.get("a").unwrap().unwrap().expose(), "van een andere kopie");
        assert_eq!(c.get_fresh("a").unwrap().unwrap().expose(), "nieuw");
        assert_eq!(c.get("a").unwrap().unwrap().expose(), "nieuw");
    }

    /// Schrijft een nepsleutel in de echte sleutelhanger en ruimt die op. Uitvoeren met `cargo test -- --ignored`.
    #[test]
    #[ignore = "gebruikt de echte sleutelhanger"]
    fn keychain_round_trip() {
        let keychain = Keychain::new("app.deepdive.reader.unittest");
        let account = format!("test:{}", uuid::Uuid::new_v4().simple());
        assert!(keychain.get(&account).unwrap().is_none());
        keychain.set(&account, &ApiKey::new("nep-sleutel")).unwrap();
        assert_eq!(keychain.get(&account).unwrap().unwrap().expose(), "nep-sleutel");
        keychain.delete(&account).unwrap();
        assert!(keychain.get(&account).unwrap().is_none());
        keychain.delete(&account).unwrap();
    }
}

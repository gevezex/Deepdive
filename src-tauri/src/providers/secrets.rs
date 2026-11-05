//! Bewaarplek voor API-sleutels. In de app is dat de sleutelhanger van het besturingssysteem.

use crate::ai::ApiKey;
use crate::error::AppError;

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<ApiKey>, AppError>;
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

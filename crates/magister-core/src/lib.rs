//! Shared Magister protocol logic, used by both the desktop app
//! (`src-tauri`, which re-exports these modules to keep every existing
//! `crate::auth::` / `crate::tls::` / `crate::client::TokenSet` path working)
//! and the future stateless web API.
//!
//! Deliberately dependency-free of Tauri, keyrings, and on-disk state:
//! persistence stays in each app (`TokenSetPersistence` in src-tauri,
//! encrypted refresh storage in web-api's optional push module).

pub mod auth;
pub mod cookies;
pub mod jsparser;
pub mod tls;
pub mod tokens;

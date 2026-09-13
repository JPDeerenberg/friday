//! Bundled-root TLS configuration for every `reqwest::Client` in this app.
//!
//! Implementation moved to `magister_core::tls` so the web API can reuse it
//! (see there for the full rationale: reqwest 0.13's platform-verifier backend
//! panics on Android without a JNI init call). This module re-exports the two
//! builders to keep all existing `crate::tls::` paths working unchanged.
//!
//! **Every `reqwest::Client` in this codebase should be built via
//! [`client_builder`] / [`new_client`] below, never `reqwest::Client::new()`
//! or `reqwest::Client::builder()` directly.**

pub use magister_core::tls::{client_builder, new_client};

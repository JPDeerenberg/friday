//! Bundled-root TLS configuration for every `reqwest::Client` in this app.
//!
//! ## Why this file exists
//!
//! `reqwest`'s `rustls` feature (as of reqwest 0.13, which this app upgraded
//! to from 0.12) verifies server certificates via `rustls-platform-verifier`,
//! which delegates to each OS's native trust store. On Android that requires
//! an explicit, one-time JNI init call —
//! `rustls_platform_verifier::android::init_with_env(&mut env, context)` —
//! made with a real JVM `Env`/`Context`, before ANY TLS handshake. This app
//! never makes that call (it would also need a small Kotlin/Gradle component
//! bundled into `src-tauri/gen/android`, per the crate's README). So on
//! Android, the very first HTTPS request panics:
//!
//!   thread 'tokio-rt-worker' panicked at rustls-platform-verifier-0.7.0/src/android.rs:90:10:
//!   Expect rustls-platform-verifier to be initialized
//!
//! That panic happens on a background tokio task. With this project's
//! current release profile (`panic = "unwind"`, the default — the explicit
//! `panic = "abort"` that 2.1.0 had was dropped at some point), only that
//! one task dies; the rest of the app keeps running. Whatever Tauri command
//! triggered the request — e.g. `AuthFlow::exchange_code()`, called the
//! moment the `m6loapp://` deep link fires after the browser redirect —
//! never resolves on the frontend. That's the "stuck on the spinner after
//! returning from the browser" bug: not a crash, just a promise that never
//! settles.
//!
//! reqwest 0.12's `rustls-tls` feature (what this app used before the 0.13
//! bump) never had this problem because it verified against a bundled,
//! static snapshot of Mozilla's root store (`webpki-roots`) instead of the
//! OS trust store — no platform/JNI integration needed. reqwest 0.13 removed
//! that as a selectable feature entirely (there is no more
//! "rustls-tls-webpki-roots"-equivalent flag; `rustls` and
//! `rustls-no-provider` both unconditionally pull in
//! `rustls-platform-verifier`). So we reconstruct the same bundled-root
//! behavior by hand here, and hand it to `reqwest` via its
//! `tls_backend_preconfigured()` escape hatch instead of letting `reqwest`
//! build its own (platform-verifier-based) config.
//!
//! **Every `reqwest::Client` in this codebase should be built via
//! [`client_builder`] / [`new_client`] below, never `reqwest::Client::new()`
//! or `reqwest::Client::builder()` directly** — otherwise it'll go back to
//! the default (platform-verifier) backend and reintroduce this bug on
//! Android.
//!
//! ## Trade-off, and a note for later
//!
//! Bundled roots are static (they update only when this app is rebuilt with
//! a newer `webpki-roots`), and skip OS-level revocation checks (OCSP/CRLs)
//! and any custom/enterprise CAs the device trusts. That's an identical
//! trade-off to what 2.1.0 already shipped with, just restored — not a new
//! regression. Switching to the OS-native trust store (better security
//! posture, per `rustls-platform-verifier`'s own README) is a reasonable
//! follow-up, but needs the Kotlin/Gradle component wired into
//! `src-tauri/gen/android` plus the JNI init call above threaded through
//! `MainActivity.kt` — a bigger, Android-build-toolchain-dependent change
//! that couldn't be verified in this environment, so it's deliberately not
//! part of this fix.

/// A `rustls::ClientConfig` that trusts the bundled Mozilla root store
/// (`webpki-roots`) instead of the OS-native store.
fn tls_config() -> rustls::ClientConfig {
    let root_store = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth()
}

/// A `reqwest::ClientBuilder` pre-configured with the bundled root store.
/// Chain any further options (timeouts, redirect policy, ...) onto this,
/// exactly as you would starting from `reqwest::Client::builder()`.
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().tls_backend_preconfigured(tls_config())
}

/// Drop-in replacement for `reqwest::Client::new()`.
pub fn new_client() -> reqwest::Client {
    client_builder()
        .build()
        .expect("failed to build reqwest client with bundled TLS roots")
}

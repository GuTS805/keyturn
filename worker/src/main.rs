//! Reads one JSON request on stdin, writes one JSON result on stdout.
//!
//! The request has a "mode":
//!   "publish"       {package, version, approved_hash, artifact_url}
//!   "stage_approve" {stage_id, package, version, approved_hash}   (default)
//!   "chrome"        {package (extension id), version, approved_hash, artifact_url}
//!
//! Environment:
//!   NPM_TOKEN             token (secret)
//!   NPM_TOTP_SECRET       base32 seed, only for stage_approve (secret)
//!   KEYTURN_NPM_REGISTRY  registry base URL, defaults to https://registry.npmjs.org
//!   KEYTURN_ALLOW_HTTP    set to 1 to allow http artifact URLs (local mocks only)
//!
//! Chrome mode:
//!   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN   Google OAuth client (secrets)
//!   CWS_PUBLISHER_ID      the Chrome Web Store publisher id
//!   CRX_PRIVATE_KEY       RSA signing key in PEM form (secret); its id is the extension id
//!   KEYTURN_CWS_API       defaults to https://chromewebstore.googleapis.com
//!   KEYTURN_OAUTH_URL     defaults to https://oauth2.googleapis.com

use keyturn_worker::chrome::{run_chrome, ChromeEndpoints, ChromeInput, ChromeSecrets, DEFAULT_API, DEFAULT_OAUTH};
#[cfg(feature = "native")]
use keyturn_worker::http::native::UreqHttp as Client;
#[cfg(all(not(feature = "native"), target_os = "wasi"))]
use keyturn_worker::wasi_http::WasiHttp as Client;
#[cfg(not(any(feature = "native", target_os = "wasi")))]
compile_error!("build with the native feature, or for a wasi target");
use keyturn_worker::{fit_output, run, run_publish, Input, Output, PublishInput, PublishOptions, Secrets, DEFAULT_REGISTRY};
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

fn emit(out: &Output) {
    println!("{}", fit_output(out));
}

fn fail(error: &str, detail: &str) -> ! {
    emit(&Output::failure(error, detail));
    std::process::exit(2);
}

fn main() {
    let mut raw = String::new();
    if std::io::stdin().take(64 * 1024).read_to_string(&mut raw).is_err() {
        fail("bad_input", "stdin is not valid text");
    }
    let mut request: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => fail("bad_input", &format!("request is not valid JSON: {}", e)),
    };
    let mode = match request.as_object_mut().and_then(|o| o.remove("mode")) {
        Some(serde_json::Value::String(m)) => m,
        Some(_) => fail("bad_input", "mode must be a string"),
        None => "stage_approve".to_string(),
    };

    if mode == "chrome" {
        let input: ChromeInput = match serde_json::from_value(request) {
            Ok(i) => i,
            Err(e) => fail("bad_input", &format!("request is not valid: {}", e)),
        };
        let need = |name: &str| std::env::var(name).unwrap_or_else(|_| fail("bad_secret", &format!("{} must be set", name)));
        let secrets = ChromeSecrets {
            client_id: need("CWS_CLIENT_ID"),
            client_secret: need("CWS_CLIENT_SECRET"),
            refresh_token: need("CWS_REFRESH_TOKEN"),
            publisher_id: need("CWS_PUBLISHER_ID"),
            private_key_pem: need("CRX_PRIVATE_KEY"),
        };
        let endpoints = ChromeEndpoints {
            api: std::env::var("KEYTURN_CWS_API").unwrap_or_else(|_| DEFAULT_API.to_string()),
            oauth: std::env::var("KEYTURN_OAUTH_URL").unwrap_or_else(|_| DEFAULT_OAUTH.to_string()),
        };
        let opts = PublishOptions {
            allow_http_artifacts: std::env::var("KEYTURN_ALLOW_HTTP").map(|v| v == "1").unwrap_or(false),
            ..PublishOptions::default()
        };
        let out = run_chrome(&input, &secrets, &endpoints, &Client::new(), &opts);
        emit(&out);
        if !out.ok {
            std::process::exit(2);
        }
        return;
    }

    let Ok(token) = std::env::var("NPM_TOKEN") else {
        fail("bad_secret", "NPM_TOKEN must be set");
    };
    let registry = std::env::var("KEYTURN_NPM_REGISTRY").unwrap_or_else(|_| DEFAULT_REGISTRY.to_string());
    let http = Client::new();

    let out = match mode.as_str() {
        "publish" => {
            let input: PublishInput = match serde_json::from_value(request) {
                Ok(i) => i,
                Err(e) => fail("bad_input", &format!("request is not valid: {}", e)),
            };
            let opts = PublishOptions {
                allow_http_artifacts: std::env::var("KEYTURN_ALLOW_HTTP").map(|v| v == "1").unwrap_or(false),
                ..PublishOptions::default()
            };
            run_publish(&input, &Secrets { token, totp_secret: String::new() }, &registry, &http, &opts)
        }
        "stage_approve" => {
            let input: Input = match serde_json::from_value(request) {
                Ok(i) => i,
                Err(e) => fail("bad_input", &format!("request is not valid: {}", e)),
            };
            let Ok(totp_secret) = std::env::var("NPM_TOTP_SECRET") else {
                fail("bad_secret", "NPM_TOTP_SECRET must be set for stage_approve");
            };
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            run(&input, &Secrets { token, totp_secret }, &registry, &http, now)
        }
        other => fail("bad_input", &format!("unknown mode \"{}\"", other)),
    };
    emit(&out);
    if !out.ok {
        std::process::exit(2);
    }
}

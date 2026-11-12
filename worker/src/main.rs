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

fn bad(error: &str, detail: impl Into<String>) -> Output {
    Output::failure(error, detail.into())
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|v| v == "1").unwrap_or(false)
}

fn handle() -> Result<Output, Output> {
    let mut raw = String::new();
    if std::io::stdin().take(64 * 1024).read_to_string(&mut raw).is_err() {
        return Err(bad("bad_input", "stdin is not valid text"));
    }
    let mut request: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| bad("bad_input", format!("request is not valid JSON: {}", e)))?;
    let mode = match request.as_object_mut().and_then(|o| o.remove("mode")) {
        Some(serde_json::Value::String(m)) => m,
        Some(_) => return Err(bad("bad_input", "mode must be a string")),
        None => "stage_approve".to_string(),
    };
    let invalid = |e: serde_json::Error| bad("bad_input", format!("request is not valid: {}", e));
    let need = |name: &str| std::env::var(name).map_err(|_| bad("bad_secret", format!("{} must be set", name)));

    if mode == "chrome" {
        let input: ChromeInput = serde_json::from_value(request).map_err(invalid)?;
        let secrets = ChromeSecrets {
            client_id: need("CWS_CLIENT_ID")?,
            client_secret: need("CWS_CLIENT_SECRET")?,
            refresh_token: need("CWS_REFRESH_TOKEN")?,
            publisher_id: need("CWS_PUBLISHER_ID")?,
            private_key_pem: need("CRX_PRIVATE_KEY")?,
        };
        let endpoints = ChromeEndpoints {
            api: std::env::var("KEYTURN_CWS_API").unwrap_or_else(|_| DEFAULT_API.to_string()),
            oauth: std::env::var("KEYTURN_OAUTH_URL").unwrap_or_else(|_| DEFAULT_OAUTH.to_string()),
        };
        let opts = PublishOptions { allow_http_artifacts: env_flag("KEYTURN_ALLOW_HTTP"), ..PublishOptions::default() };
        return Ok(run_chrome(&input, &secrets, &endpoints, &Client::new(), &opts));
    }

    let token = need("NPM_TOKEN")?;
    let registry = std::env::var("KEYTURN_NPM_REGISTRY").unwrap_or_else(|_| DEFAULT_REGISTRY.to_string());
    let http = Client::new();

    match mode.as_str() {
        "publish" => {
            let input: PublishInput = serde_json::from_value(request).map_err(invalid)?;
            let opts = PublishOptions { allow_http_artifacts: env_flag("KEYTURN_ALLOW_HTTP"), ..PublishOptions::default() };
            Ok(run_publish(&input, &Secrets { token, totp_secret: String::new() }, &registry, &http, &opts))
        }
        "stage_approve" => {
            let input: Input = serde_json::from_value(request).map_err(invalid)?;
            let totp_secret = need("NPM_TOTP_SECRET")?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            Ok(run(&input, &Secrets { token, totp_secret }, &registry, &http, now))
        }
        other => Err(bad("bad_input", format!("unknown mode \"{}\"", other))),
    }
}

fn main() {
    let out = handle().unwrap_or_else(|e| e);
    emit(&out);
    // The result says whether it worked. A native caller also gets a non-zero exit
    // code. Inside a TEE runtime a non-zero exit is reported as a crash and the JSON
    // is thrown away, so the wasm build always returns normally.
    #[cfg(feature = "native")]
    if !out.ok {
        std::process::exit(2);
    }
}

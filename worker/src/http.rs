//! Minimal HTTP abstraction so the worker logic can run against a real
//! registry, a mock registry, or an in-memory fake in tests.

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait Http {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String>;
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String>;
}

/// Largest body the worker will read from a registry.
pub const MAX_BODY: u64 = 64 * 1024 * 1024;

#[cfg(feature = "native")]
pub mod native {
    use super::{Http, Response, MAX_BODY};
    use std::io::Read;
    use std::time::Duration;

    pub struct UreqHttp {
        agent: ureq::Agent,
    }

    impl UreqHttp {
        pub fn new() -> Self {
            let agent = ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(60))
                .redirects(0)
                .build();
            Self { agent }
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

    impl Http for UreqHttp {
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
            let mut req = self.agent.get(url);
            for (k, v) in headers {
                req = req.set(k, v);
            }
            finish(req.call())
        }

        fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
            let mut req = self.agent.post(url);
            for (k, v) in headers {
                req = req.set(k, v);
            }
            finish(req.send_bytes(body))
        }
    }
}

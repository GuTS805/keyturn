//! HTTP for the WASI build, over `wasi:http` (what OutLayer provides).
//!
//! WASI HTTP does not follow redirects. Requests that carry credentials must
//! not follow them anyway. Only `fetch_public`, which carries nothing, follows a
//! few, and only to https (or to http when the first address was http, which
//! only local mocks use).

use crate::http::{Http, Response, MAX_BODY};
use std::time::Duration;
use wasi_http_client::Client;

pub struct WasiHttp;

impl WasiHttp {
    pub fn new() -> Self {
        WasiHttp
    }
}

impl Default for WasiHttp {
    fn default() -> Self {
        Self::new()
    }
}

fn read(resp: wasi_http_client::Response) -> Result<(u16, Option<String>, Vec<u8>), String> {
    let status = resp.status();
    let location = resp.headers().iter().find(|(k, _)| k.eq_ignore_ascii_case("location")).map(|(_, v)| v.clone());
    let mut body = Vec::new();
    loop {
        match resp.chunk(1024 * 1024) {
            Ok(Some(chunk)) => {
                body.extend_from_slice(&chunk);
                if body.len() as u64 > MAX_BODY {
                    return Err("response body is too large".to_string());
                }
            }
            Ok(None) => break,
            Err(_) => return Err("could not read response body".to_string()),
        }
    }
    Ok((status, location, body))
}

fn send(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> Result<(u16, Option<String>, Vec<u8>), String> {
    let client = Client::new();
    let mut req = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        _ => return Err("unsupported method".to_string()),
    }
    .connect_timeout(Duration::from_secs(20));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().map_err(|_| "request failed".to_string())?;
    read(resp)
}

impl Http for WasiHttp {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
        let (status, _, body) = send("GET", url, headers, None)?;
        Ok(Response { status, body })
    }

    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
        let (status, _, body) = send("POST", url, headers, Some(body))?;
        Ok(Response { status, body })
    }

    fn put(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
        let (status, _, body) = send("PUT", url, headers, Some(body))?;
        Ok(Response { status, body })
    }

    fn fetch_public(&self, url: &str) -> Result<Response, String> {
        let first_is_http = url.starts_with("http://");
        let mut current = url.to_string();
        for _ in 0..=4 {
            let (status, location, body) = send("GET", &current, &[], None)?;
            if (300..400).contains(&status) {
                let Some(next) = location else {
                    return Err("redirect without a location".to_string());
                };
                if next.starts_with("https://") || (first_is_http && next.starts_with("http://")) {
                    current = next;
                    continue;
                }
                return Err("redirect to an address that is not allowed".to_string());
            }
            return Ok(Response { status, body });
        }
        Err("too many redirects".to_string())
    }
}

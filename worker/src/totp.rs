//! RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 second step).

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

/// RFC 4226 HOTP with a dynamic truncation, returning `digits` digits as a number.
pub fn hotp(key: &[u8], counter: u64, digits: u32) -> u32 {
    let mut mac = HmacSha1::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let bin = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    bin % 10u32.pow(digits)
}

/// Six digit TOTP for a base32 secret at the given unix time.
pub fn totp(secret_base32: &str, unix_seconds: u64) -> Result<String, String> {
    let cleaned: String = secret_base32
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect::<String>()
        .to_uppercase();
    let key = BASE32_NOPAD
        .decode(cleaned.as_bytes())
        .map_err(|_| "totp secret is not valid base32".to_string())?;
    if key.is_empty() {
        return Err("totp secret is empty".to_string());
    }
    Ok(format!("{:06}", hotp(&key, unix_seconds / 30, 6)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 appendix B, SHA1, secret "12345678901234567890".
    const RFC_SECRET: &[u8] = b"12345678901234567890";

    #[test]
    fn matches_rfc_6238_vectors() {
        assert_eq!(hotp(RFC_SECRET, 59 / 30, 8), 94287082);
        assert_eq!(hotp(RFC_SECRET, 1111111109 / 30, 8), 7081804);
        assert_eq!(hotp(RFC_SECRET, 1111111111 / 30, 8), 14050471);
        assert_eq!(hotp(RFC_SECRET, 1234567890 / 30, 8), 89005924);
        assert_eq!(hotp(RFC_SECRET, 2000000000 / 30, 8), 69279037);
    }

    #[test]
    fn six_digit_code_from_base32() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(totp(secret, 59).unwrap(), "287082");
    }

    #[test]
    fn accepts_spaced_lowercase_secrets() {
        let secret = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq";
        assert_eq!(totp(secret, 59).unwrap(), "287082");
    }

    #[test]
    fn rejects_garbage() {
        assert!(totp("not base32 !!", 59).is_err());
        assert!(totp("", 59).is_err());
    }
}

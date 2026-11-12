//! A local chain for demos and tests: the real contract code, run natively,
//! driven by JSON lines on stdin. No network and no NEAR account needed.
//!
//!   cargo run --example localchain -- worker.local
//!
//! Request:  {"kind":"call"|"view","method":"approve_release","sender":"ada.local",
//!            "args":{...},"deposit_yocto":"0","now_ms":1000}
//! Response: one line starting with "REPLY " then {"ok":true,"result":...,"logs":[...]} or {"ok":false,"error":"..."}
//!
//! The sender and the clock come from the request, so a caller can act as any
//! account and move time forward. Every contract `require!` runs as on chain.
//! A call that panics leaves the state unchanged, because every check in the
//! contract runs before it changes anything (the unit tests rely on this too).

use keyturn_contract::{Keyturn, Registry};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn account(v: &Value, what: &str) -> AccountId {
    v.as_str()
        .unwrap_or_else(|| panic!("{} is missing", what))
        .parse()
        .unwrap_or_else(|_| panic!("{} is not a valid account id", what))
}

fn text(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("argument {} is missing", key))
        .to_string()
}

fn context(sender: &AccountId, now_ms: u64, deposit: u128, view: bool) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(sender.clone())
        .signer_account_id(sender.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .is_view(view);
    testing_env!(b.build());
}

fn dispatch(c: &mut Keyturn, method: &str, a: &Value) -> Value {
    let p = || text(a, "project_id");
    let v = || text(a, "version");
    match method {
        "register_project" => {
            let registry: Registry = serde_json::from_value(a["registry"].clone()).expect("registry is Npm or Chrome");
            let members: Vec<AccountId> = serde_json::from_value(a["members"].clone()).expect("members is a list of accounts");
            let proposers: Vec<AccountId> = serde_json::from_value(a.get("proposers").cloned().unwrap_or(json!([])))
                .expect("proposers is a list of accounts");
            let threshold = a["threshold"].as_u64().expect("threshold is a number") as u8;
            let window_ms = a["window_ms"].as_u64().expect("window_ms is a number");
            c.register_project(text(a, "id"), registry, members, proposers, threshold, window_ms);
            Value::Null
        }
        "propose_release" => {
            c.propose_release(p(), v(), text(a, "artifact_hash"));
            Value::Null
        }
        "approve_release" => {
            c.approve_release(p(), v());
            Value::Null
        }
        "flag_release" => {
            c.flag_release(p(), v(), text(a, "reason"));
            Value::Null
        }
        "dismiss_flag" => {
            c.dismiss_flag(p(), v());
            Value::Null
        }
        "reject_release" => {
            c.reject_release(p(), v());
            Value::Null
        }
        "execute_release" => {
            c.execute_release(p(), v());
            Value::Null
        }
        "confirm_published" => {
            c.confirm_published(p(), v(), text(a, "published_hash"));
            Value::Null
        }
        "recall_release" => {
            c.recall_release(p(), v());
            Value::Null
        }
        "get_worker" => json!(c.get_worker()),
        "get_project" => serde_json::to_value(c.get_project(p())).unwrap(),
        "get_release" => serde_json::to_value(c.get_release(p(), v())).unwrap(),
        "is_released" => json!(c.is_released(p(), v(), text(a, "artifact_hash"))),
        other => panic!("unknown method {}", other),
    }
}

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    let raw = payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "the call failed".to_string());
    // near-sdk prefixes panics with a type name in native mode; keep the message.
    raw.trim_start_matches("Smart contract panicked: ").to_string()
}

fn main() {
    let worker: AccountId = std::env::args()
        .nth(1)
        .expect("give the worker account id as the first argument")
        .parse()
        .expect("worker is not a valid account id");
    std::panic::set_hook(Box::new(|_| {}));

    context(&worker, 0, 0, false);
    let mut contract = Keyturn::new(worker);

    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin closed");
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Err(e) => json!({ "ok": false, "error": format!("bad request: {}", e) }),
            Ok(req) => {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    let sender = account(&req["sender"], "sender");
                    let now_ms = req["now_ms"].as_u64().unwrap_or(0);
                    let deposit: u128 = req["deposit_yocto"].as_str().unwrap_or("0").parse().expect("deposit_yocto is a number");
                    let view = req["kind"] == "view";
                    context(&sender, now_ms, if view { 0 } else { deposit }, view);
                    let method = req["method"].as_str().expect("method is missing").to_string();
                    let value = dispatch(&mut contract, &method, req.get("args").unwrap_or(&Value::Null));
                    (value, get_logs())
                }));
                match result {
                    Ok((value, logs)) => json!({ "ok": true, "result": value, "logs": logs }),
                    Err(payload) => json!({ "ok": false, "error": panic_text(payload) }),
                }
            }
        };
        writeln!(out, "REPLY {}", reply).expect("stdout closed");
        out.flush().expect("stdout closed");
    }
}

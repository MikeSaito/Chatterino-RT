//! Same verification algorithm and trust anchor as the production Tauri updater.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

fn verify(
    artifact: &[u8],
    signature: &str,
    pubkey: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let key = String::from_utf8(STANDARD.decode(pubkey.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    PublicKey::decode(&key)?.verify(artifact, &Signature::decode(&signature)?, true)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: verify-updater <artifact> <signature-file>".into());
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("missing updater key")?;
    verify(
        &std::fs::read(&args[0])?,
        &std::fs::read_to_string(&args[1])?,
        key,
    )?;
    println!("Updater signature verified");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_signature_and_key() {
        assert!(verify(b"tampered", "bad", "bad").is_err());
    }
}

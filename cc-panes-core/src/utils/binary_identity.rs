//! Binary identity must describe file contents, not process startup time.
use std::io::{self, Read};
use std::path::Path;
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

pub fn binary_sha256(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            return Ok(format!("{:x}", hasher.finalize()));
        }
        hasher.update(&buffer[..count]);
    }
}

/// Capture once, before the executable may be replaced on disk by an installer.
pub fn current_binary_sha256() -> Option<&'static str> {
    static IDENTITY: OnceLock<Option<String>> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| binary_sha256(&path).ok())
        })
        .as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_tracks_contents_even_when_path_and_file_length_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon");
        std::fs::write(&path, b"abc").unwrap();
        let first = binary_sha256(&path).unwrap();
        assert_eq!(
            first,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::write(&path, b"xyz").unwrap();
        assert_ne!(first, binary_sha256(&path).unwrap());
    }

    #[test]
    fn missing_binary_is_an_error_not_a_matching_identity() {
        let dir = tempfile::tempdir().unwrap();
        assert!(binary_sha256(&dir.path().join("missing")).is_err());
    }
}

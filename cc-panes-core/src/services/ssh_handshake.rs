use anyhow::{bail, Result};
use ssh2::{Error, ErrorCode, Session};
use std::time::{Duration, Instant};

const AGAIN: ErrorCode = ErrorCode::Session(-37);

pub(super) fn handshake(session: &mut Session, timeout: Duration) -> Result<()> {
    session.set_blocking(false);
    let result = retry(|| session.handshake(), timeout);
    // Failed handshakes must also remain nonblocking during libssh2 cleanup.
    if result.is_ok() {
        session.set_blocking(true);
    }
    result
}

fn retry(mut attempt: impl FnMut() -> Result<(), Error>, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match attempt() {
            Ok(()) => return Ok(()),
            Err(error) if error.code() == AGAIN => {
                if Instant::now() >= deadline {
                    bail!("SSH handshake timed out");
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advances_nonblocking_handshake_and_bounds_a_silent_peer() {
        let mut attempts = 0;
        retry(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(Error::from_errno(AGAIN))
                } else {
                    Ok(())
                }
            },
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(attempts, 3);
        let error = retry(|| Err(Error::from_errno(AGAIN)), Duration::ZERO).unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
    #[test]
    fn does_not_retry_protocol_failure() {
        let mut attempts = 0;
        assert!(retry(
            || {
                attempts += 1;
                Err(Error::from_errno(ErrorCode::Session(-1)))
            },
            Duration::from_secs(1)
        )
        .is_err());
        assert_eq!(attempts, 1);
    }
}

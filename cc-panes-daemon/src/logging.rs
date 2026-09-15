//! Bounded diagnostic logging. Formatting threads never perform disk or stderr I/O.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

const MAX_FILE_BYTES: u64 = 10_000_000;
const RETAINED_FILES: usize = 5; // daemon.log plus four archives
const MAX_EVENT_BYTES: usize = 16 * 1024;
const QUEUE_EVENTS: usize = 1024;

enum Message {
    Event(Vec<u8>),
    Flush(mpsc::SyncSender<()>),
}
#[derive(Clone)]
struct LogWriter {
    tx: mpsc::SyncSender<Message>,
    dropped: Arc<AtomicU64>,
}
struct EventWriter {
    logger: LogWriter,
    bytes: Vec<u8>,
}
impl Write for EventWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = MAX_EVENT_BYTES.saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for EventWriter {
    fn drop(&mut self) {
        if !self.bytes.is_empty()
            && self
                .logger
                .tx
                .try_send(Message::Event(std::mem::take(&mut self.bytes)))
                .is_err()
        {
            self.logger.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogWriter {
    type Writer = EventWriter;
    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            logger: self.clone(),
            bytes: Vec::new(),
        }
    }
}

pub struct LogGuard(LogWriter);
impl Drop for LogGuard {
    fn drop(&mut self) {
        let (tx, rx) = mpsc::sync_channel(1);
        if self.0.tx.try_send(Message::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

struct RollingLog {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    max_bytes: u64,
}
impl RollingLog {
    fn open(path: PathBuf, max_bytes: u64) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            bytes,
            max_bytes,
        })
    }
    fn archive(&self, index: usize) -> PathBuf {
        self.path.with_extension(format!("log.{index}"))
    }
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.bytes + bytes.len() as u64 > self.max_bytes {
            drop(self.file.take());
            for index in (1..RETAINED_FILES).rev() {
                let dest = self.archive(index);
                if dest.exists() {
                    std::fs::remove_file(&dest)?;
                }
                let source = if index == 1 {
                    self.path.clone()
                } else {
                    self.archive(index - 1)
                };
                if source.exists() {
                    std::fs::rename(source, dest)?;
                }
            }
            self.bytes = 0;
        }
        if self.file.is_none() {
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
        }
        self.file.as_mut().unwrap().write_all(bytes)?;
        self.bytes += bytes.len() as u64;
        Ok(())
    }
}

pub fn init(data_dir: Option<&str>, runtime_dir: Option<&Path>) -> io::Result<LogGuard> {
    let root = data_dir
        .map(PathBuf::from)
        .or_else(|| runtime_dir.and_then(|p| p.parent().map(Path::to_path_buf)))
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = root.join("logs");
    let mut log = std::fs::create_dir_all(&dir)
        .and_then(|()| RollingLog::open(dir.join("daemon.log"), MAX_FILE_BYTES))
        .map_err(|error| {
            eprintln!("daemon file logging unavailable: {error}");
            error
        })
        .ok();
    let (tx, rx) = mpsc::sync_channel(QUEUE_EVENTS);
    let dropped = Arc::new(AtomicU64::new(0));
    let dropped_worker = dropped.clone();
    std::thread::Builder::new()
        .name("cc-panes-log".into())
        .spawn(move || {
            while let Ok(message) = rx.recv() {
                match message {
                    Message::Event(bytes) => {
                        let dropped = dropped_worker.swap(0, Ordering::Relaxed);
                        if let Some(log) = log.as_mut() {
                            if dropped > 0 {
                                let _ = log.write(
                                    format!("diagnostic log queue dropped {dropped} events\n")
                                        .as_bytes(),
                                );
                            }
                        }
                        let text = String::from_utf8_lossy(&bytes);
                        let _ = io::stderr().write_all(text.as_bytes());
                        if let Some(log) = log.as_mut() {
                            if let Err(error) = log.write(text.as_bytes()) {
                                let _ = writeln!(io::stderr(), "daemon log: {error}");
                            }
                        }
                    }
                    Message::Flush(done) => {
                        if let Some(file) = log.as_mut().and_then(|log| log.file.as_mut()) {
                            let _ = file.flush();
                        }
                        let _ = done.send(());
                    }
                }
            }
        })?;
    let writer = LogWriter { tx, dropped };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "cc_panes_daemon=info,cc_panes_core=info".into());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(writer.clone())
        .init();
    Ok(LogGuard(writer))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_bounds_files_and_preserves_recent_records() {
        let dir = std::env::temp_dir().join(format!(
            "cc-panes-logs-{}-{}",
            std::process::id(),
            crate::server::generate_token()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut log = RollingLog::open(dir.join("daemon.log"), 20).unwrap();
        for i in 0..25 {
            log.write(format!("event-{i:02}\n").as_bytes()).unwrap();
        }
        drop(log);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), RETAINED_FILES);
        assert!(std::fs::read_to_string(dir.join("daemon.log"))
            .unwrap()
            .contains("event-24"));
        for entry in std::fs::read_dir(&dir).unwrap() {
            assert!(entry.unwrap().metadata().unwrap().len() <= 20);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

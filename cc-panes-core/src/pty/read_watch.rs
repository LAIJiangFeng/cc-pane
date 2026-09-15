//! Read-only PTY progress and reader lifetime diagnostics. Never operates the PTY.
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Default)]
struct ReadState {
    reading_since: Option<Instant>,
    last_output: Option<Instant>,
    phase: &'static str,
    phase_since: Option<Instant>,
    alive: bool,
    panicked: bool,
}

#[derive(Default)]
pub struct ReaderIoWatch {
    state: Mutex<ReadState>,
}
pub struct ReaderScope(Arc<ReaderIoWatch>);

impl Drop for ReaderScope {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.alive = false;
        state.panicked = std::thread::panicking();
        state.reading_since = None;
        state.phase = "stopped";
        state.phase_since = Some(Instant::now());
    }
}

impl ReaderIoWatch {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn reader_scope(self: &Arc<Self>) -> ReaderScope {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).alive = true;
        ReaderScope(Arc::clone(self))
    }
    pub fn processing(&self, phase: &'static str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.phase = phase;
        state.phase_since = Some(Instant::now());
    }
    pub fn lifecycle(&self) -> Option<(bool, bool, &'static str, Option<u64>)> {
        let state = self.state.lock().ok()?;
        Some((
            state.alive,
            state.panicked,
            state.phase,
            state.phase_since.map(|at| at.elapsed().as_millis() as u64),
        ))
    }
    pub fn mark_attempt(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.reading_since = Some(Instant::now());
        state.phase = "read";
        state.phase_since = state.reading_since;
    }
    pub fn mark_returned(&self, has_output: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.reading_since = None;
        if has_output {
            state.last_output = Some(Instant::now());
        }
    }
    pub fn blocked_ms(&self) -> Option<u64> {
        self.state
            .lock()
            .ok()?
            .reading_since
            .map(|at| at.elapsed().as_millis() as u64)
    }
    pub fn last_ok_ms_ago(&self) -> Option<u64> {
        self.state
            .lock()
            .ok()?
            .last_output
            .map(|at| at.elapsed().as_millis() as u64)
    }
    /// Compatibility field: automatic PTY resize probes have been removed.
    pub fn recovery_count(&self) -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn natural_reader_exit_releases_lifetime_state() {
        let watch = Arc::new(ReaderIoWatch::new());
        {
            let _scope = watch.reader_scope();
            watch.mark_attempt();
            assert!(watch.lifecycle().unwrap().0);
        }
        assert!(!watch.lifecycle().unwrap().0);
        assert_eq!(watch.blocked_ms(), None);
        assert_eq!(Arc::strong_count(&watch), 1);
    }
    #[test]
    fn panic_is_observable_without_retaining_a_reader_or_process() {
        let watch = Arc::new(ReaderIoWatch::new());
        let _ = std::panic::catch_unwind({
            let watch = watch.clone();
            move || {
                let _scope = watch.reader_scope();
                panic!("test reader failure");
            }
        });
        let (alive, panicked, _, _) = watch.lifecycle().unwrap();
        assert!(!alive && panicked);
        assert_eq!(Arc::strong_count(&watch), 1);
    }
    #[test]
    fn completed_read_clears_wait_and_records_output_progress() {
        let watch = ReaderIoWatch::new();
        watch.mark_attempt();
        assert!(watch.blocked_ms().is_some());
        watch.mark_returned(true);
        assert_eq!(watch.blocked_ms(), None);
        assert!(watch.last_ok_ms_ago().is_some());
    }
}

use std::time::{Duration, Instant};

const NORMAL_DELAY: Duration = Duration::from_millis(16);

/// A batch deadline must not slide forward whenever another small chunk arrives.
/// Keep the normal budget anchored to the first chunk in the batch.
#[derive(Default)]
pub(super) struct OutputBatchClock {
    deadline: Option<Instant>,
}

impl OutputBatchClock {
    pub(super) fn note_data(&mut self, now: Instant) {
        self.deadline.get_or_insert(now + NORMAL_DELAY);
    }

    pub(super) fn wait(&self, now: Instant) -> Duration {
        self.deadline.map_or(NORMAL_DELAY, |deadline| {
            deadline.saturating_duration_since(now)
        })
    }

    pub(super) fn due(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }

    pub(super) fn clear(&mut self) {
        self.deadline = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_small_chunks_do_not_postpone_the_first_batch() {
        let start = Instant::now();
        let mut clock = OutputBatchClock::default();
        for elapsed in [0, 4, 8, 12] {
            let now = start + Duration::from_millis(elapsed);
            clock.note_data(now);
            assert_eq!(clock.wait(now), Duration::from_millis(16 - elapsed));
        }
        let deadline = start + Duration::from_millis(16);
        clock.note_data(deadline);
        assert!(clock.due(deadline));
        assert_eq!(clock.wait(deadline), Duration::ZERO);
    }

    #[test]
    fn additional_chunks_keep_the_normal_batch_budget() {
        let start = Instant::now();
        let mut clock = OutputBatchClock::default();
        clock.note_data(start);
        clock.note_data(start + Duration::from_millis(4));
        assert_eq!(
            clock.wait(start + Duration::from_millis(4)),
            Duration::from_millis(12)
        );
        clock.note_data(start + Duration::from_millis(5));
        assert!(!clock.due(start + Duration::from_millis(6)));
    }

    #[test]
    fn later_chunks_do_not_extend_an_earlier_deadline() {
        let start = Instant::now();
        let mut clock = OutputBatchClock::default();
        clock.note_data(start);
        clock.note_data(start + Duration::from_millis(15));
        assert_eq!(
            clock.wait(start + Duration::from_millis(15)),
            Duration::from_millis(1)
        );
    }

    #[test]
    fn flush_starts_a_new_independent_batch_and_idle_has_no_deadline() {
        let start = Instant::now();
        let mut clock = OutputBatchClock::default();
        assert!(!clock.due(start));
        clock.note_data(start);
        assert!(clock.due(start + NORMAL_DELAY));
        clock.clear();
        assert_eq!(clock.wait(start + NORMAL_DELAY), NORMAL_DELAY);
        assert!(!clock.due(start + NORMAL_DELAY));
        clock.note_data(start + NORMAL_DELAY);
        assert_eq!(clock.wait(start + NORMAL_DELAY), NORMAL_DELAY);
    }
}

//! Fixed-window per-key rate limiter. No dependencies, no background task:
//! stale entries are pruned opportunistically when the map grows.

use std::collections::HashMap;
use std::time::{Duration, Instant};

struct Window {
    start: Instant,
    count: u32,
}

/// Allows `max_hits` per `window` per key.
pub struct RateLimiter {
    max_hits: u32,
    window: Duration,
    hits: HashMap<String, Window>,
    /// Prune when the map exceeds this many keys (bounds memory on a tiny VPS).
    prune_at: usize,
}

impl RateLimiter {
    pub fn new(max_hits: u32, window: Duration) -> Self {
        Self { max_hits, window, hits: HashMap::new(), prune_at: 10_000 }
    }

    /// True when the call is allowed (and counted). False when limited.
    pub fn check(&mut self, key: &str) -> bool {
        let now = Instant::now();
        if self.hits.len() >= self.prune_at {
            self.hits.retain(|_, w| now.duration_since(w.start) < self.window);
        }
        match self.hits.get_mut(key) {
            Some(w) if now.duration_since(w.start) < self.window => {
                if w.count >= self.max_hits {
                    return false;
                }
                w.count += 1;
                true
            }
            _ => {
                self.hits.insert(key.to_string(), Window { start: now, count: 1 });
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_max_then_blocks() {
        let mut rl = RateLimiter::new(3, Duration::from_secs(60));
        assert!(rl.check("k"));
        assert!(rl.check("k"));
        assert!(rl.check("k"));
        assert!(!rl.check("k"));
        // Other keys unaffected.
        assert!(rl.check("other"));
    }

    #[test]
    fn window_expiry_resets() {
        let mut rl = RateLimiter::new(1, Duration::from_millis(30));
        assert!(rl.check("k"));
        assert!(!rl.check("k"));
        std::thread::sleep(Duration::from_millis(40));
        assert!(rl.check("k"));
    }
}

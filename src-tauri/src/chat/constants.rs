pub const BATCH_FLUSH_MS: u64 = 40;
pub const BATCH_MAX_MESSAGES: usize = 64;
pub const BATCH_MAX_BYTES: usize = 64 * 1024;
pub const SCROLLBACK_LIMIT: usize = 1000;
pub const MESSAGE_POOL_SIZE: usize = SCROLLBACK_LIMIT;
pub const EMOTE_SLOTS_PER_ROW: usize = 12;
pub const TEXTURE_LRU_LIMIT: usize = 256;

const _: () = {
    assert!(MESSAGE_POOL_SIZE == SCROLLBACK_LIMIT);
    assert!(EMOTE_SLOTS_PER_ROW > 0);
    assert!(TEXTURE_LRU_LIMIT > 0);
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_matches_scrollback() {
        assert_eq!(MESSAGE_POOL_SIZE, SCROLLBACK_LIMIT);
        assert_eq!(EMOTE_SLOTS_PER_ROW, 12);
        assert_eq!(TEXTURE_LRU_LIMIT, 256);
        assert_eq!(BATCH_FLUSH_MS, 40);
    }
}

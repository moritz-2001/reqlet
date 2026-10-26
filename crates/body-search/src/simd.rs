//! Skips impossible UTF-16 candidates eight units at a time. `find_anchored`
//! verifies only complete literal candidates and bounds comparisons before KMP.

use super::{folded_unit, splits_pair, Match, SkippedSearch};
use core::arch::wasm32::{
    i16x8_bitmask, i16x8_eq, i16x8_splat, u16x8_gt, v128, v128_load, v128_or,
};

/// Searches candidate anchors with SIMD; callers guarantee SIMD module support.
///
/// # Safety
/// The executing Wasm host must support SIMD128. The host compiles the complete
/// module before using this function and falls back when that compilation fails.
#[target_feature(enable = "simd128")]
pub(super) unsafe fn find_anchored<const BACKWARD: bool>(
    units: &[u16],
    source: &[u16],
    from: usize,
    to: usize,
) -> SkippedSearch {
    let length = units.len();
    if length > source.len() || BACKWARD && to < length {
        return SkippedSearch::Complete(None);
    }

    let first = if BACKWARD {
        from.saturating_sub(length - 1)
    } else {
        from
    };
    let last = if BACKWARD {
        to - length
    } else {
        (to - 1).min(source.len() - length)
    };
    if first > last {
        return SkippedSearch::Complete(None);
    }

    let anchor = choose_anchor(units);
    let offset = if BACKWARD {
        length - anchor - 1
    } else {
        anchor
    };
    let filter = AnchorFilter::new(units[anchor]);
    let mut budget = (to - from).saturating_add(length).saturating_mul(2);
    let mut cursor = if BACKWARD { last + 1 } else { first };
    loop {
        let remaining = if BACKWARD {
            cursor - first
        } else {
            last + 1 - cursor
        };
        if remaining == 0 {
            return SkippedSearch::Complete(None);
        }

        let width = remaining.min(8);
        let block = if BACKWARD { cursor - width } else { cursor };
        let mut mask = if width == 8 {
            // Every lane is a complete candidate start at or below `last`, and
            // `offset < length`; therefore all eight loaded units belong to the
            // source. v128_load permits an unaligned source pointer.
            let vector = unsafe { v128_load(source.as_ptr().add(block + offset).cast()) };
            filter.mask(vector)
        } else {
            let mut mask = 0;
            for index in 0..width {
                if filter.accepts(source[block + offset + index]) {
                    mask |= 1 << index;
                }
            }
            mask
        };
        while mask != 0 {
            let index = if BACKWARD {
                31 - mask.leading_zeros()
            } else {
                mask.trailing_zeros()
            } as usize;
            mask &= !(1 << index);
            let start = block + index;
            match verify::<BACKWARD>(units, source, start, anchor, &mut budget) {
                Verification::Match => {
                    return SkippedSearch::Complete(Some(Match {
                        from: start,
                        to: start + length,
                    }));
                }
                Verification::Miss => {}
                Verification::Exhausted => {
                    return SkippedSearch::ContinueAt(if BACKWARD {
                        start + length
                    } else {
                        start
                    });
                }
            }
        }
        cursor = if BACKWARD { block } else { block + width };
    }
}

struct AnchorFilter {
    // Folded query unit selected as the candidate anchor.
    unit: u16,
    // ASCII uppercase equivalent, or `unit` when no alternate is needed.
    alternate: u16,
    // The Unicode-only ASCII-fold alias, or `unit` when none exists.
    exceptional: u16,
}

impl AnchorFilter {
    fn new(unit: u16) -> Self {
        let alternate = if (b'a' as u16..=b'z' as u16).contains(&unit) {
            unit - 0x20
        } else {
            unit
        };
        // The pinned C/S data has exactly these two non-ASCII mappings into
        // ASCII. The generator verifies this assumption against the full data.
        let exceptional = match unit {
            0x6b => 0x212a,
            0x73 => 0x017f,
            _ => unit,
        };
        Self {
            unit,
            alternate,
            exceptional,
        }
    }

    #[target_feature(enable = "simd128")]
    fn mask(&self, vector: v128) -> u32 {
        let candidates = if self.unit < 0x80 {
            v128_or(
                v128_or(
                    i16x8_eq(vector, i16x8_splat(self.unit as i16)),
                    i16x8_eq(vector, i16x8_splat(self.alternate as i16)),
                ),
                i16x8_eq(vector, i16x8_splat(self.exceptional as i16)),
            )
        } else {
            // A query without any ASCII anchor still skips ASCII response text
            // in full vectors. Candidate verification handles Unicode classes.
            u16x8_gt(vector, i16x8_splat(0x7f))
        };
        u32::from(i16x8_bitmask(candidates))
    }

    fn accepts(&self, unit: u16) -> bool {
        if self.unit < 0x80 {
            unit == self.unit || unit == self.alternate || unit == self.exceptional
        } else {
            unit >= 0x80
        }
    }
}

fn choose_anchor(units: &[u16]) -> usize {
    // Favor punctuation absent from most JSON values, then uncommon letters.
    // This only changes the amount of verification; every candidate still uses
    // the complete query and original source boundaries.
    units
        .iter()
        .enumerate()
        .min_by_key(|(_, &unit)| match unit {
            0..=0x7f if !(unit as u8).is_ascii_alphanumeric() => match unit {
                0x20 | 0x22 | 0x2c | 0x3a | 0x5b | 0x5d | 0x7b | 0x7d => 100,
                _ => 0,
            },
            0x61..=0x7a => {
                b"zqxjkvbpygfwmucldrhsnioate"
                    .iter()
                    .position(|&letter| u16::from(letter) == unit)
                    .unwrap_or(25)
                    + 1
            }
            0..=0x7f => 50,
            _ => 200,
        })
        .map(|(index, _)| index)
        .unwrap()
}

enum Verification {
    Match,
    Miss,
    Exhausted,
}

fn verify<const BACKWARD: bool>(
    units: &[u16],
    source: &[u16],
    start: usize,
    anchor: usize,
    budget: &mut usize,
) -> Verification {
    let length = units.len();
    for turn in 0..length {
        if *budget == 0 {
            return Verification::Exhausted;
        }
        *budget -= 1;

        // Check the anchor first to reject broad non-ASCII masks cheaply; then
        // visit each remaining query unit exactly once in source scan order.
        let index = if turn == 0 {
            anchor
        } else if turn <= anchor {
            turn - 1
        } else {
            turn
        };
        let offset = if BACKWARD { length - index - 1 } else { index };
        if folded_unit(source, start + offset) != units[index] {
            return Verification::Miss;
        }
    }

    if splits_pair(source, start) || splits_pair(source, start + length) {
        Verification::Miss
    } else {
        Verification::Match
    }
}

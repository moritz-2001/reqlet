//! Searches original UTF-16 response bodies without copying or normalizing them.
//! `SearchQuery` compiles a literal once, then scans bounded candidate ranges in
//! either direction so its caller can yield or cancel between ranges.

#[cfg(target_arch = "wasm32")]
mod simd;
mod simple_fold;

/// Maximum supported query length, measured in original UTF-16 code units.
pub const MAX_QUERY_LENGTH: usize = 4096;

/// A reusable, case-insensitive literal query over original UTF-16 response text.
///
/// Matching uses Unicode default simple case folding, as escaped JavaScript
/// literals do with the `iu` regular-expression flags. It does not expand `ß`
/// into `ss`, normalize combining sequences, or combine unpaired surrogates.
/// The query owns its small search tables; source bodies stay with the caller.
pub struct SearchQuery {
    /// Folded query scalars and forward failure links, built once at construction.
    forward: Pattern,
    /// The same scalars in reverse order, allowing backward scans to stop at the
    /// rightmost occurrence instead of collecting every earlier occurrence.
    backward: Pattern,
    /// Original query width, used to turn complete scalar matches into UTF-16
    /// source offsets. Every supported simple-fold mapping preserves this width.
    utf16_length: usize,
}

impl SearchQuery {
    /// Compiles a nonempty literal of at most [`MAX_QUERY_LENGTH`] UTF-16 units.
    /// Returns `None` for empty or oversized queries; unpaired surrogates are
    /// accepted and match only equivalent unpaired surrogates in source text.
    pub fn new(query: &[u16]) -> Option<Self> {
        if query.is_empty() || query.len() > MAX_QUERY_LENGTH {
            return None;
        }

        let mut scalars = Vec::with_capacity(query.len());
        let mut position = 0;
        while position < query.len() {
            scalars.push(simple_fold::fold(next_scalar(query, &mut position)));
        }
        let forward = Pattern::new(scalars.clone(), false);
        scalars.reverse();

        Some(Self {
            forward,
            backward: Pattern::new(scalars, true),
            utf16_length: query.len(),
        })
    }

    /// Finds the first literal occurrence in the requested candidate range.
    ///
    /// Forward ranges accept starts in `[from, to)`; backward ranges accept ends
    /// in `(from, to]` and choose the rightmost occurrence, including overlaps.
    /// Bounds are clamped to the source length, and reversed or empty ranges
    /// return `None`. Matches may extend outside the candidate range, but always
    /// remain within the complete source.
    ///
    /// To yield between chunks, pass consecutive candidate ranges with at most
    /// 64 Ki UTF-16 units each. Each call reads at most the candidate width plus
    /// the query width and two boundary units, uses constant scratch storage,
    /// and never copies the body. A full-range search takes linear time in the
    /// body and query lengths; chunked searches add at most one query of context
    /// per chunk. The source must remain unchanged between related chunk calls.
    ///
    /// ```
    /// use body_search::{Direction, Match, SearchQuery};
    ///
    /// let source: Vec<u16> = "one TWO two".encode_utf16().collect();
    /// let query = SearchQuery::new(&"two".encode_utf16().collect::<Vec<_>>()).unwrap();
    /// assert_eq!(query.find_in_range(&source, 0, source.len(), Direction::Forward),
    ///     Some(Match { from: 4, to: 7 }));
    /// assert_eq!(query.find_in_range(&source, 0, source.len(), Direction::Backward),
    ///     Some(Match { from: 8, to: 11 }));
    /// ```
    pub fn find_in_range(
        &self,
        source: &[u16],
        from: usize,
        to: usize,
        direction: Direction,
    ) -> Option<Match> {
        let from = from.min(source.len());
        let to = to.min(source.len());
        if from >= to {
            return None;
        }

        match direction {
            Direction::Forward => self.find_forward(source, from, to),
            Direction::Backward => self.find_backward(source, from, to),
        }
    }

    fn find_forward(&self, source: &[u16], from: usize, to: usize) -> Option<Match> {
        let from = match self.forward.find_skipping::<false>(source, from, to) {
            SkippedSearch::Complete(found) => return found,
            SkippedSearch::ContinueAt(from) => from,
        };
        let mut position = boundary_before(source, from);
        let end = boundary_after(
            source,
            to.saturating_add(self.utf16_length - 1).min(source.len()),
        );
        let mut matched = 0;

        while position < end {
            let scalar = simple_fold::fold(next_scalar(source, &mut position));
            matched = self.forward.advance(matched, scalar);
            if matched == self.forward.scalars.len() {
                let start = position - self.utf16_length;
                if start >= from && start < to {
                    return Some(Match {
                        from: start,
                        to: position,
                    });
                }
                matched = self.forward.failure[matched - 1];
            }
        }

        None
    }

    fn find_backward(&self, source: &[u16], from: usize, to: usize) -> Option<Match> {
        let to = match self.backward.find_skipping::<true>(source, from, to) {
            SkippedSearch::Complete(found) => return found,
            SkippedSearch::ContinueAt(to) => to,
        };
        let start = boundary_before(source, from.saturating_sub(self.utf16_length - 1));
        let mut position = boundary_after(source, to);
        let mut matched = 0;

        while position > start {
            let scalar = simple_fold::fold(previous_scalar(source, &mut position));
            matched = self.backward.advance(matched, scalar);
            if matched == self.backward.scalars.len() {
                let end = position + self.utf16_length;
                if end <= to && end > from {
                    return Some(Match {
                        from: position,
                        to: end,
                    });
                }
                matched = self.backward.failure[matched - 1];
            }
        }

        None
    }
}

/// Direction in original source order; backward matching includes overlaps.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    /// Choose the occurrence with the smallest accepted start offset.
    Forward,
    /// Choose the occurrence with the greatest accepted end offset.
    Backward,
}

/// Half-open UTF-16 offsets into the unchanged source body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Match {
    /// Inclusive original-source offset where the matched literal begins.
    pub from: usize,
    /// Exclusive original-source offset immediately after the matched literal.
    pub to: usize,
}

struct Pattern {
    scalars: Vec<u32>,
    // A mismatch continues at the longest already-matched prefix. This avoids
    // rereading source on repetitive bodies or adversarial repeated-prefix text.
    failure: Vec<usize>,
    // UTF-16 spelling of the same folded scalars, used to skip impossible
    // candidates cheaply. Reverse patterns reverse complete units as well as
    // scalars so this representation matches a backwards walk through source.
    units: Vec<u16>,
    // Colliding unit hashes use the smallest safe shift. The fixed table keeps
    // query preparation bounded without allocating a full Unicode alphabet.
    #[cfg(not(target_arch = "wasm32"))]
    skip: [usize; 256],
}

impl Pattern {
    fn new(scalars: Vec<u32>, reverse_units: bool) -> Self {
        let mut failure = vec![0; scalars.len()];
        let mut matched = 0;
        for position in 1..scalars.len() {
            while matched > 0 && scalars[matched] != scalars[position] {
                matched = failure[matched - 1];
            }
            if scalars[matched] == scalars[position] {
                matched += 1;
            }
            failure[position] = matched;
        }

        let mut units = Vec::with_capacity(scalars.len());
        for &scalar in &scalars {
            if scalar <= 0xffff {
                units.push(scalar as u16);
            } else {
                let high = ((scalar - 0x10000) >> 10) as u16 + 0xd800;
                let low = ((scalar - 0x10000) & 0x3ff) as u16 + 0xdc00;
                if reverse_units {
                    units.extend([low, high]);
                } else {
                    units.extend([high, low]);
                }
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        let mut skip = [units.len(); 256];
        #[cfg(not(target_arch = "wasm32"))]
        for (index, &unit) in units.iter().enumerate().take(units.len() - 1) {
            let hash = usize::from(unit & 0xff);
            skip[hash] = skip[hash].min(units.len() - index - 1);
        }

        Self {
            scalars,
            failure,
            units,
            #[cfg(not(target_arch = "wasm32"))]
            skip,
        }
    }

    fn advance(&self, mut matched: usize, scalar: u32) -> usize {
        while matched > 0 && self.scalars[matched] != scalar {
            matched = self.failure[matched - 1];
        }
        if self.scalars[matched] == scalar {
            matched += 1;
        }
        matched
    }

    fn find_skipping<const BACKWARD: bool>(
        &self,
        source: &[u16],
        from: usize,
        to: usize,
    ) -> SkippedSearch {
        #[cfg(target_arch = "wasm32")]
        {
            // Unsupported WebViews reject this module during compilation; the
            // host then selects its existing JavaScript search fallback.
            unsafe { simd::find_anchored::<BACKWARD>(&self.units, source, from, to) }
        }
        #[cfg(not(target_arch = "wasm32"))]
        self.find_horspool::<BACKWARD>(source, from, to)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn find_horspool<const BACKWARD: bool>(
        &self,
        source: &[u16],
        from: usize,
        to: usize,
    ) -> SkippedSearch {
        let length = self.units.len();
        if length > source.len() {
            return SkippedSearch::Complete(None);
        }

        // Horspool skips are fast for ordinary literals, but repeated suffixes
        // can make comparisons quadratic. Spend only linear work before handing
        // the remaining candidate range to the scalar KMP scan above.
        let mut budget = (to - from).saturating_add(length).saturating_mul(2);
        let mut cursor = if BACKWARD { to } else { from };
        loop {
            let start = if !BACKWARD {
                if cursor >= to || cursor > source.len() - length {
                    return SkippedSearch::Complete(None);
                }
                cursor
            } else {
                if cursor <= from || cursor < length {
                    return SkippedSearch::Complete(None);
                }
                cursor - length
            };
            let edge = if !BACKWARD { start + length - 1 } else { start };
            let last = folded_unit(source, edge);
            let mut matched = 0;
            while matched < length {
                if budget == 0 {
                    return SkippedSearch::ContinueAt(cursor);
                }
                budget -= 1;

                let offset = if !BACKWARD {
                    length - matched - 1
                } else {
                    matched
                };
                let actual = if matched == 0 {
                    last
                } else {
                    folded_unit(source, start + offset)
                };
                let expected = self.units[length - matched - 1];
                if actual != expected {
                    break;
                }
                matched += 1;
            }

            if matched == length
                && !splits_pair(source, start)
                && !splits_pair(source, start + length)
            {
                return SkippedSearch::Complete(Some(Match {
                    from: start,
                    to: start + length,
                }));
            }
            let shift = self.skip[usize::from(last & 0xff)];
            cursor = if !BACKWARD {
                cursor.saturating_add(shift)
            } else {
                cursor.saturating_sub(shift)
            };
        }
    }
}

enum SkippedSearch {
    Complete(Option<Match>),
    ContinueAt(usize),
}

#[inline]
fn folded_unit(source: &[u16], position: usize) -> u16 {
    let unit = source[position];
    if unit < 0x80 {
        return if (b'A' as u16..=b'Z' as u16).contains(&unit) {
            unit + 0x20
        } else {
            unit
        };
    }

    if is_high_surrogate(unit) && position + 1 < source.len() {
        let low = source[position + 1];
        if is_low_surrogate(low) {
            let folded = simple_fold::fold(pair_scalar(unit, low));
            return ((folded - 0x10000) >> 10) as u16 + 0xd800;
        }
    } else if is_low_surrogate(unit) && position > 0 {
        let high = source[position - 1];
        if is_high_surrogate(high) {
            let folded = simple_fold::fold(pair_scalar(high, unit));
            return ((folded - 0x10000) & 0x3ff) as u16 + 0xdc00;
        }
    }
    simple_fold::fold(u32::from(unit)) as u16
}

fn next_scalar(source: &[u16], position: &mut usize) -> u32 {
    let first = source[*position];
    *position += 1;
    if is_high_surrogate(first) && *position < source.len() {
        let second = source[*position];
        if is_low_surrogate(second) {
            *position += 1;
            return pair_scalar(first, second);
        }
    }
    u32::from(first)
}

fn previous_scalar(source: &[u16], position: &mut usize) -> u32 {
    *position -= 1;
    let second = source[*position];
    if is_low_surrogate(second) && *position > 0 {
        let first = source[*position - 1];
        if is_high_surrogate(first) {
            *position -= 1;
            return pair_scalar(first, second);
        }
    }
    u32::from(second)
}

fn boundary_before(source: &[u16], position: usize) -> usize {
    if splits_pair(source, position) {
        position - 1
    } else {
        position
    }
}

fn boundary_after(source: &[u16], position: usize) -> usize {
    if splits_pair(source, position) {
        position + 1
    } else {
        position
    }
}

fn splits_pair(source: &[u16], position: usize) -> bool {
    position > 0
        && position < source.len()
        && is_high_surrogate(source[position - 1])
        && is_low_surrogate(source[position])
}

fn pair_scalar(high: u16, low: u16) -> u32 {
    0x10000 + ((u32::from(high) - 0xd800) << 10) + u32::from(low) - 0xdc00
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

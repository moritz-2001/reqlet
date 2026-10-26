//! Exercises `SearchQuery` through its UTF-16 interface, including Unicode
//! equivalence, candidate boundaries, overlapping navigation, and chunking.

use body_search::{Direction, Match, SearchQuery, MAX_QUERY_LENGTH};
use std::collections::BTreeMap;

#[test]
fn compiles_only_nonempty_queries_within_the_utf16_limit() {
    assert!(SearchQuery::new(&[]).is_none());
    assert!(SearchQuery::new(&vec![b'a' as u16; MAX_QUERY_LENGTH]).is_some());
    assert!(SearchQuery::new(&vec![b'a' as u16; MAX_QUERY_LENGTH + 1]).is_none());
    assert!(SearchQuery::new(&utf16(&"😀".repeat(MAX_QUERY_LENGTH / 2))).is_some());
    assert!(SearchQuery::new(&utf16(&"😀".repeat(MAX_QUERY_LENGTH / 2 + 1))).is_none());
}

#[test]
fn searches_literal_metacharacters_and_preserves_source_offsets() {
    let source = utf16("😀\r\n[a.*]\\ [A.*]\\");
    let query = SearchQuery::new(&utf16("[a.*]\\")).unwrap();
    assert_eq!(
        query.find_in_range(&source, 0, source.len(), Direction::Forward),
        Some(Match { from: 4, to: 10 })
    );
    assert_eq!(
        query.find_in_range(&source, 0, source.len(), Direction::Backward),
        Some(Match { from: 11, to: 17 })
    );
}

#[test]
fn backward_search_returns_the_rightmost_overlapping_occurrence() {
    let source = utf16("aaaaa");
    let query = SearchQuery::new(&utf16("aaa")).unwrap();
    for (end, expected) in [
        (5, Some(Match { from: 2, to: 5 })),
        (4, Some(Match { from: 1, to: 4 })),
        (3, Some(Match { from: 0, to: 3 })),
        (2, None),
    ] {
        assert_eq!(
            query.find_in_range(&source, 0, end, Direction::Backward),
            expected
        );
    }
}

#[test]
fn candidate_bounds_allow_matches_to_cross_a_wrap_boundary() {
    let source = utf16("abc");
    let query = SearchQuery::new(&utf16("abc")).unwrap();
    assert_eq!(
        query.find_in_range(&source, 0, 1, Direction::Forward),
        Some(Match { from: 0, to: 3 })
    );
    assert_eq!(
        query.find_in_range(&source, 2, 3, Direction::Backward),
        Some(Match { from: 0, to: 3 })
    );
    assert_eq!(query.find_in_range(&source, 1, 3, Direction::Forward), None);
    assert_eq!(
        query.find_in_range(&source, 0, 2, Direction::Backward),
        None
    );
    assert_eq!(query.find_in_range(&source, 3, 1, Direction::Forward), None);
}

#[test]
fn unicode_folding_is_simple_and_does_not_normalize_or_expand() {
    for (source, query) in [
        ("KKk", "k"),
        ("sſS", "S"),
        ("Σςσ", "σ"),
        ("ßẞ", "ß"),
        ("Ꭰꭰ", "ꭰ"),
        ("𐐀𐐨", "𐐨"),
    ] {
        let source = utf16(source);
        let query_units = utf16(query);
        let query = SearchQuery::new(&query_units).unwrap();
        assert_eq!(
            query.find_in_range(&source, 0, source.len(), Direction::Forward),
            Some(Match {
                from: 0,
                to: query_units.len()
            })
        );
        assert_eq!(
            query.find_in_range(&source, 0, source.len(), Direction::Backward),
            Some(Match {
                from: source.len() - query_units.len(),
                to: source.len()
            })
        );
    }

    for (source, query) in [("ß", "ss"), ("ﬀ", "ff"), ("İ", "i"), ("é", "e\u{301}")] {
        let source = utf16(source);
        let query = SearchQuery::new(&utf16(query)).unwrap();
        assert_eq!(
            query.find_in_range(&source, 0, source.len(), Direction::Forward),
            None
        );
    }
}

#[test]
fn lone_surrogates_match_only_lone_surrogates_at_every_boundary() {
    let source = [0xd800, 0xdc00, b'a' as u16, 0xd800, b'b' as u16, 0xdc00];
    let high = SearchQuery::new(&[0xd800]).unwrap();
    let low = SearchQuery::new(&[0xdc00]).unwrap();
    for direction in [Direction::Forward, Direction::Backward] {
        assert_eq!(
            high.find_in_range(&source, 0, source.len(), direction),
            Some(Match { from: 3, to: 4 })
        );
        assert_eq!(
            low.find_in_range(&source, 0, source.len(), direction),
            Some(Match { from: 5, to: 6 })
        );
        assert_eq!(high.find_in_range(&source, 0, 2, direction), None);
        assert_eq!(low.find_in_range(&source, 0, 2, direction), None);
    }

    let pair = SearchQuery::new(&[0xd800, 0xdc00]).unwrap();
    assert_eq!(pair.find_in_range(&source, 1, 2, Direction::Forward), None);
    assert_eq!(pair.find_in_range(&source, 0, 1, Direction::Backward), None);
    assert_eq!(
        pair.find_in_range(&source, 0, 1, Direction::Forward),
        Some(Match { from: 0, to: 2 })
    );
    assert_eq!(
        pair.find_in_range(&source, 1, 2, Direction::Backward),
        Some(Match { from: 0, to: 2 })
    );
}

#[test]
fn every_candidate_range_matches_an_independent_unicode_literal_oracle() {
    let mut source = utf16("AaKΣς𐐀𐐨😀aaAA\r\n");
    source.extend([0xd800, b'a' as u16, 0xdc00, 0xd800, 0xdc00]);
    let queries = [
        utf16("a"),
        utf16("aaa"),
        utf16("k"),
        utf16("σ"),
        utf16("𐐨"),
        utf16("😀"),
        utf16("\r\n"),
        vec![0xd800],
        vec![0xdc00],
        vec![0xd800, 0xdc00],
        vec![0xdc00, 0xd800, 0xdc00],
    ];
    let mappings = unicode_mappings();
    for units in queries {
        let query = SearchQuery::new(&units).unwrap();
        let occurrences = reference_matches(&source, &units, &mappings);
        for from in 0..=source.len() + 1 {
            for to in 0..=source.len() + 1 {
                for direction in [Direction::Forward, Direction::Backward] {
                    let expected = if from >= to {
                        None
                    } else if direction == Direction::Forward {
                        occurrences
                            .iter()
                            .find(|found| found.from >= from && found.from < to)
                            .copied()
                    } else {
                        occurrences
                            .iter()
                            .rev()
                            .find(|found| found.to > from && found.to <= to)
                            .copied()
                    };
                    assert_eq!(
                        query.find_in_range(&source, from, to, direction),
                        expected,
                        "query {units:x?}, range {from}..{to}, direction {direction:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn bounded_chunks_find_crossing_matches_in_both_directions() {
    let mut source = vec![b'x' as u16; 65_535];
    source.extend(utf16("𐐀needle"));
    source.extend(vec![b'x' as u16; 65_535]);
    source.extend(utf16("𐐨NEEDLE"));
    let query = SearchQuery::new(&utf16("𐐨needle")).unwrap();
    assert_eq!(
        query.find_in_range(&source, 0, 65_536, Direction::Forward),
        Some(Match {
            from: 65_535,
            to: 65_543
        })
    );
    assert_eq!(
        query.find_in_range(&source, 65_536, source.len(), Direction::Backward),
        Some(Match {
            from: 131_078,
            to: 131_086
        })
    );
    assert_eq!(
        query.find_in_range(&source, 65_536, 65_543, Direction::Backward),
        Some(Match {
            from: 65_535,
            to: 65_543
        })
    );
}

#[test]
fn repeated_prefixes_do_not_hide_the_first_or_last_complete_match() {
    let mut source = vec![b'a' as u16; 200_000];
    source.push(b'b' as u16);
    let mut units = vec![b'a' as u16; MAX_QUERY_LENGTH - 1];
    units.push(b'b' as u16);
    let query = SearchQuery::new(&units).unwrap();
    let expected = Some(Match {
        from: source.len() - units.len(),
        to: source.len(),
    });
    assert_eq!(
        query.find_in_range(&source, 0, source.len(), Direction::Forward),
        expected
    );
    assert_eq!(
        query.find_in_range(&source, 0, source.len(), Direction::Backward),
        expected
    );
}

#[test]
fn repeated_suffixes_preserve_matches_after_the_linear_scan_fallback() {
    let mut units = vec![b'a' as u16; MAX_QUERY_LENGTH];
    units[0] = b'b' as u16;
    let mut source = vec![b'a' as u16; 200_000];
    source.extend(&units);
    let query = SearchQuery::new(&units).unwrap();
    assert_eq!(
        query.find_in_range(&source, 0, source.len(), Direction::Forward),
        Some(Match {
            from: 200_000,
            to: source.len()
        })
    );

    source.reverse();
    units.reverse();
    let query = SearchQuery::new(&units).unwrap();
    assert_eq!(
        query.find_in_range(&source, 0, source.len(), Direction::Backward),
        Some(Match {
            from: 0,
            to: MAX_QUERY_LENGTH
        })
    );
}

#[test]
fn every_official_common_and_simple_fold_matches_in_both_directions() {
    for (source, target) in unicode_mappings() {
        let source_units = scalar_utf16(source);
        let target_units = scalar_utf16(target);
        assert_eq!(source_units.len(), target_units.len());
        for (body, literal) in [
            (&source_units, &target_units),
            (&target_units, &source_units),
        ] {
            let query = SearchQuery::new(literal).unwrap();
            for direction in [Direction::Forward, Direction::Backward] {
                assert_eq!(
                    query.find_in_range(body, 0, body.len(), direction),
                    Some(Match {
                        from: 0,
                        to: body.len()
                    }),
                    "U+{source:04X} folds to U+{target:04X}"
                );
            }
        }
    }
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn scalar_utf16(scalar: u32) -> Vec<u16> {
    let mut units = [0; 2];
    char::from_u32(scalar)
        .unwrap()
        .encode_utf16(&mut units)
        .to_vec()
}

fn unicode_mappings() -> BTreeMap<u32, u32> {
    include_str!("../CaseFolding.txt")
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('#').next()?.split(';').map(str::trim);
            let source = fields.next()?;
            let status = fields.next()?;
            let target = fields.next()?;
            matches!(status, "C" | "S").then(|| {
                (
                    u32::from_str_radix(source, 16).unwrap(),
                    u32::from_str_radix(target, 16).unwrap(),
                )
            })
        })
        .collect()
}

fn reference_matches(source: &[u16], query: &[u16], mappings: &BTreeMap<u32, u32>) -> Vec<Match> {
    let source = reference_scalars(source, mappings);
    let query = reference_scalars(query, mappings);
    source
        .windows(query.len())
        .filter(|window| {
            window
                .iter()
                .zip(&query)
                .all(|(left, right)| left.0 == right.0)
        })
        .map(|window| Match {
            from: window.first().unwrap().1,
            to: window.last().unwrap().2,
        })
        .collect()
}

fn reference_scalars(source: &[u16], mappings: &BTreeMap<u32, u32>) -> Vec<(u32, usize, usize)> {
    let mut offset = 0;
    char::decode_utf16(source.iter().copied())
        .map(|decoded| {
            let (scalar, width) = match decoded {
                Ok(scalar) => (u32::from(scalar), scalar.len_utf16()),
                Err(error) => (u32::from(error.unpaired_surrogate()), 1),
            };
            let from = offset;
            offset += width;
            (*mappings.get(&scalar).unwrap_or(&scalar), from, offset)
        })
        .collect()
}

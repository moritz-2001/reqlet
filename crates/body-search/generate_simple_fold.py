#!/usr/bin/env python3
"""Regenerate Rust's simple-fold table from the pinned official Unicode data."""

import hashlib
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent
    source = (root / "CaseFolding.txt").read_bytes()
    expected = "ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183"
    if hashlib.sha256(source).hexdigest() != expected:
        raise ValueError("Expected the pinned Unicode 17.0.0 CaseFolding.txt")

    mappings = {}
    for line in source.decode("utf-8").splitlines():
        record = line.split("#", 1)[0].strip()
        if not record:
            continue
        codepoint, status, mapping, *_ = (part.strip() for part in record.split(";"))
        if status not in ("C", "S"):
            continue
        targets = mapping.split()
        if len(targets) != 1:
            raise ValueError("Simple folding must produce one scalar")
        scalar, target = int(codepoint, 16), int(targets[0], 16)
        if (scalar > 0xFFFF) != (target > 0xFFFF):
            raise ValueError("UTF-16 match offsets require width-preserving folding")
        mappings[scalar] = target

    # Use ultimate targets even if a future reviewed table introduces a chain.
    for scalar in mappings:
        target = mappings[scalar]
        visited = {scalar}
        while target in mappings:
            if target in visited:
                raise ValueError("Simple-fold mappings must not form a cycle")
            visited.add(target)
            target = mappings[target]
        mappings[scalar] = target

    ascii_exceptions = {
        scalar: target for scalar, target in mappings.items() if scalar >= 128 and target < 128
    }
    if ascii_exceptions != {0x017F: 0x0073, 0x212A: 0x006B}:
        raise ValueError("Review SIMD ASCII anchor aliases before updating the folding table")

    lines = [
        "//! Unicode default simple folding used by `SearchQuery`; generated, do not edit.",
        "//! Source: https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt (C/S records).",
        "//! Run `python3 crates/body-search/generate_simple_fold.py` to reproduce.",
        "//! Unicode data is covered by the adjacent `UNICODE-LICENSE.txt`.",
        "",
        "pub(super) fn fold(scalar: u32) -> u32 {",
        "    if scalar < 0x80 {",
        "        return if (0x41..=0x5a).contains(&scalar) {",
        "            scalar + 0x20",
        "        } else {",
        "            scalar",
        "        };",
        "    }",
        "",
        "    match MAPPINGS.binary_search_by_key(&scalar, |&(source, _)| source) {",
        "        Ok(index) => MAPPINGS[index].1,",
        "        Err(_) => scalar,",
        "    }",
        "}",
        "",
        "const MAPPINGS: &[(u32, u32)] = &[",
    ]
    lines.extend(
        f"    (0x{scalar:04x}, 0x{target:04x}),"
        for scalar, target in sorted(mappings.items())
        if scalar >= 0x80
    )
    lines.extend(("];", ""))
    (root / "src" / "simple_fold.rs").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()

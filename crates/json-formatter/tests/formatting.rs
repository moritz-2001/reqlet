//! Exercises the public UTF-16 formatting contract, including JSONC and budgets.

use json_formatter::{format_json, FormatError};

#[test]
fn formats_nested_values_and_empty_containers() {
    assert_eq!(
        format(r#"{"items":[1,{"empty":[]}],"meta":{}}"#),
        "{\n  \"items\": [\n    1,\n    {\n      \"empty\": []\n    }\n  ],\n  \"meta\": {}\n}"
    );
    for source in [r#""  hello  ""#, "null", "true", "false", "42", "{}", "[]"] {
        assert_eq!(format(&format!(" \n{source}\t")), source);
    }
}

#[test]
fn preserves_payload_spelling_duplicate_keys_and_jsonc_extensions() {
    let source =
        r#"{"id":9007199254740993,"id":-0,"number":1.2300e+40,"text":"😀\u0061\n\"{x},:[]\\",}"#;
    assert_eq!(
        format(source),
        "{\n  \"id\": 9007199254740993,\n  \"id\": -0,\n  \"number\": 1.2300e+40,\n  \"text\": \"😀\\u0061\\n\\\"{x},:[]\\\\\",\n}"
    );
    assert_eq!(
        format("// request\n{\"items\":[1,2,],/* keep */\"id\":9007199254740993,}// end  "),
        "// request\n{\n  \"items\": [\n    1,\n    2,\n  ], /* keep */ \"id\": 9007199254740993,\n} // end  "
    );
}

#[test]
fn preserves_comment_text_and_places_separators_outside_line_comments() {
    let cases = [
        ("[1 // value  \n,2,]", "[\n  1 // value  \n  ,\n  2,\n]"),
        (
            "{\"a\" // key\n: // value\n1,}",
            "{\n  \"a\" // key\n  : // value\n  1,\n}",
        ),
        (
            "{/* before */\"a\":/* value */1/* after */}",
            "{\n  /* before */ \"a\": /* value */ 1 /* after */\n}",
        ),
        (
            "// before\r\n[/* one\r\n  two */1,] // end  ",
            "// before\n[\n  /* one\r\n  two */ 1,\n] // end  ",
        ),
        (
            "[/***/0/*x*//**/ , //\u{2028}\n1]",
            "[\n  /***/ 0 /*x*/ /**/, //\u{2028}\n  1\n]",
        ),
    ];
    for (source, expected) in cases {
        let formatted = format(source);
        assert_eq!(formatted, expected, "source: {source}");
        assert_eq!(format(&formatted), formatted);
    }
}

#[test]
fn rejects_invalid_syntax_including_invalid_numbers_strings_and_delimiters() {
    let invalid = [
        "",
        " ",
        "// comment",
        "/**/",
        "/* unfinished",
        "/",
        "undefined",
        "{} {}",
        "[",
        "{",
        "[}",
        "{]",
        "[,1]",
        "[1,,]",
        "[/* empty */,]",
        "{,}",
        "{\"a\",1}",
        "{\"a\":}",
        "{\"a\":1,1:2}",
        "{true:1}",
        "[true false]",
        "tru",
        "truex",
        "nullnull",
        "01",
        "-01",
        "-",
        "+1",
        ".1",
        "1.",
        "1e",
        "1e+",
        "1e-",
        "1e+-1",
        "NaN",
        "\"unterminated",
        "\"\\x20\"",
        "\"\\u123\"",
        "\"\\u123x\"",
        "\"\n\"",
        "\"\t\"",
        "\u{00a0}1",
        "\u{feff}1",
        "[0] trailing",
        "[1/*open]",
        "/*/0",
        "[1]/*",
    ];
    for source in invalid {
        assert_eq!(
            format_json(&utf16(source), usize::MAX),
            Err(FormatError::Invalid),
            "source: {source:?}"
        );
        assert_eq!(format_json(&utf16(source), 0), Err(FormatError::Invalid));
    }
}

#[test]
fn accepts_json_string_and_number_grammar() {
    for source in [
        "0",
        "-0",
        "10",
        "-12.30E+40",
        "0.1e-2",
        "0e0",
        "1E01",
        "\"\\/\\b\\f\\n\\r\\t\"",
        "\"\\u0000\\uD800\\udfff\"",
        "\"\u{2028}\u{2029}\"",
        "/* **/true/***/",
    ] {
        let formatted = format(source);
        assert_eq!(format(&formatted), formatted);
    }
}

#[test]
fn counts_utf16_code_units_and_preserves_surrogate_pairs_and_escape_spelling() {
    let source = [0x22, 0xd800, 0xdc00, 0x61, 0x22];
    assert_eq!(format_json(&source, source.len()).unwrap(), source);
    assert_eq!(
        format_json(&source, source.len() - 1),
        Err(FormatError::TooLarge)
    );
    assert_eq!(format_json(&utf16("\"😀\""), 4).unwrap(), utf16("\"😀\""));
    assert_eq!(format_json(&utf16("\"😀\""), 3), Err(FormatError::TooLarge));
    assert_eq!(
        format_json(&[0x22, 0x1f, 0x22], 100),
        Err(FormatError::Invalid)
    );
    assert_eq!(format_json(&[0xd800], 100), Err(FormatError::Invalid));
    for unit in [0xd800, 0xdfff] {
        assert_eq!(
            format_json(&[0x22, unit, 0x22], 100),
            Err(FormatError::Invalid)
        );
        assert_eq!(
            format_json(&[0x2f, 0x2a, unit, 0x2a, 0x2f, 0x30], 100),
            Err(FormatError::Invalid)
        );
        assert_eq!(
            format_json(&[0x2f, 0x2f, unit, 0x0a, 0x30], 100),
            Err(FormatError::Invalid)
        );
    }
    let escaped = utf16(r#""\ud800\udfff""#);
    assert_eq!(format_json(&escaped, escaped.len()).unwrap(), escaped);
}

#[test]
fn accepts_exact_budgets_and_does_not_count_discarded_trailing_whitespace() {
    for source in [
        "[] // end",
        "{/* hello */}",
        "[1,2,]",
        "1",
        "true",
        "// before\n0",
    ] {
        let formatted = utf16(&format(source));
        assert_eq!(
            format_json(&utf16(source), formatted.len()).unwrap(),
            formatted
        );
        assert_eq!(
            format_json(&utf16(source), formatted.len() - 1),
            Err(FormatError::TooLarge)
        );
    }
}

#[test]
fn validates_deep_nesting_iteratively_before_checking_the_output_budget() {
    let depth = 100_000;
    let source = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
    assert_eq!(
        format_json(&utf16(&source), 512 * 1024),
        Err(FormatError::TooLarge)
    );
    let malformed = format!("{}0{}", "[".repeat(depth), "]".repeat(depth - 1));
    assert_eq!(
        format_json(&utf16(&malformed), 0),
        Err(FormatError::Invalid)
    );

    let depth = 1000;
    let source = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
    let formatted = format_json(&utf16(&source), usize::MAX).unwrap();
    assert_eq!(formatted.len(), 2 * depth * depth + 4 * depth + 1);
}

fn format(source: &str) -> String {
    String::from_utf16(&format_json(&utf16(source), usize::MAX).unwrap()).unwrap()
}

fn utf16(source: &str) -> Vec<u16> {
    source.encode_utf16().collect()
}

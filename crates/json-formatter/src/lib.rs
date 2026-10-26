//! Formats JSONC without decoding payload values. `format_json` validates UTF-16
//! source, then writes its original tokens with bounded, two-space indentation.

/// Formats complete JSON with comments and trailing commas into UTF-16 output.
///
/// Numbers, duplicate keys, string escapes, and comments are preserved exactly.
/// Escaped surrogate code units are accepted; raw surrogates must form pairs,
/// matching the application's JSONC grammar. Both input and the inclusive output
/// limit use UTF-16 code units, matching JavaScript string positions. Validation
/// completes before the output limit is checked, so malformed source always
/// returns [`FormatError::Invalid`].
/// Nesting is processed iteratively rather than using the native or Wasm stack.
///
/// ```
/// use json_formatter::format_json;
///
/// let source: Vec<u16> = r#"{"id":9007199254740993,}"#.encode_utf16().collect();
/// let output = format_json(&source, 100).unwrap();
/// assert_eq!(String::from_utf16(&output).unwrap(), "{\n  \"id\": 9007199254740993,\n}");
/// ```
pub fn format_json(source: &[u16], max_length: usize) -> Result<Vec<u16>, FormatError> {
    validate(source)?;
    format_valid_source(source, max_length)
}

/// Explains why no formatted output could be returned.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FormatError {
    /// The complete source does not conform to the supported JSONC grammar.
    Invalid,
    /// The formatted output would exceed the inclusive UTF-16 output limit.
    TooLarge,
}

fn validate(source: &[u16]) -> Result<(), FormatError> {
    let mut tokens = Tokenizer::new(source);
    // Each open container adds one continuation. Accepting its value updates
    // the parent before pushing, so closing a container simply removes it.
    let mut states = vec![SyntaxState::RootValue];

    while let Some(token) = tokens.next_token()? {
        if token.kind.is_comment() {
            continue;
        }

        let state = states.last_mut().ok_or(FormatError::Invalid)?;
        match (*state, token.kind) {
            (SyntaxState::ArrayValueOrEnd, TokenKind::CloseArray)
            | (SyntaxState::ArrayCommaOrEnd, TokenKind::CloseArray)
            | (SyntaxState::ObjectKeyOrEnd, TokenKind::CloseObject)
            | (SyntaxState::ObjectCommaOrEnd, TokenKind::CloseObject) => {
                states.pop();
            }
            (SyntaxState::ArrayCommaOrEnd, TokenKind::Comma) => {
                *state = SyntaxState::ArrayValueOrEnd;
            }
            (SyntaxState::ObjectCommaOrEnd, TokenKind::Comma) => {
                *state = SyntaxState::ObjectKeyOrEnd;
            }
            (SyntaxState::ObjectKeyOrEnd, TokenKind::String) => {
                *state = SyntaxState::ObjectColon;
            }
            (SyntaxState::ObjectColon, TokenKind::Colon) => {
                *state = SyntaxState::ObjectValue;
            }
            (
                SyntaxState::RootValue | SyntaxState::ArrayValueOrEnd | SyntaxState::ObjectValue,
                kind,
            ) => {
                *state = match *state {
                    SyntaxState::RootValue => SyntaxState::Complete,
                    SyntaxState::ArrayValueOrEnd => SyntaxState::ArrayCommaOrEnd,
                    _ => SyntaxState::ObjectCommaOrEnd,
                };
                match kind {
                    TokenKind::OpenArray => states.push(SyntaxState::ArrayValueOrEnd),
                    TokenKind::OpenObject => states.push(SyntaxState::ObjectKeyOrEnd),
                    TokenKind::String | TokenKind::Number | TokenKind::Literal => {}
                    _ => return Err(FormatError::Invalid),
                }
            }
            _ => return Err(FormatError::Invalid),
        }
    }

    if states == [SyntaxState::Complete] {
        Ok(())
    } else {
        Err(FormatError::Invalid)
    }
}

fn format_valid_source(source: &[u16], max_length: usize) -> Result<Vec<u16>, FormatError> {
    let mut tokens = Tokenizer::new(source);
    let mut current = tokens.next_token()?;
    let mut previous: Option<Token> = None;
    let mut depth = 0;
    let mut output = Output::new(source.len(), max_length);

    while let Some(token) = current {
        let next = tokens.next_token()?;
        match token.kind {
            TokenKind::OpenObject | TokenKind::OpenArray => {
                output.append(&source[token.from..token.to])?;
                depth += 1;
                if !next.is_some_and(|next| next.kind.is_closing()) {
                    output.newline(depth);
                }
            }
            TokenKind::CloseObject | TokenKind::CloseArray => {
                depth -= 1;
                if !previous.is_some_and(|previous| previous.kind.is_opening()) {
                    output.newline(depth);
                }
                output.append(&source[token.from..token.to])?;
            }
            TokenKind::Comma => {
                output.append(&source[token.from..token.to])?;
                if next.is_some_and(|next| {
                    next.kind.is_comment() && !has_newline(&source[token.to..next.from])
                }) {
                    output.spacing = Spacing::Space;
                } else {
                    output.newline(depth);
                }
            }
            TokenKind::Colon => {
                output.append(&source[token.from..token.to])?;
                output.spacing = Spacing::Space;
            }
            TokenKind::LineComment | TokenKind::BlockComment => {
                if previous.is_some_and(|previous| has_newline(&source[previous.to..token.from])) {
                    output.newline(depth);
                } else if output.spacing == Spacing::None
                    && output
                        .units
                        .last()
                        .is_some_and(|unit| !is_js_whitespace(*unit))
                {
                    output.spacing = Spacing::Space;
                }
                output.append(&source[token.from..token.to])?;

                if token.kind == TokenKind::LineComment
                    || next.is_some_and(|next| has_newline(&source[token.to..next.from]))
                {
                    output.newline(depth);
                } else if next.is_some_and(|next| {
                    !matches!(next.kind, TokenKind::Comma | TokenKind::Colon)
                        && !next.kind.is_closing()
                }) {
                    output.spacing = Spacing::Space;
                }
            }
            TokenKind::String | TokenKind::Number | TokenKind::Literal => {
                output.append(&source[token.from..token.to])?;
            }
        }
        previous = Some(token);
        current = next;
    }

    Ok(output.units)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SyntaxState {
    RootValue,
    Complete,
    // The same state allows empty containers and a closing delimiter after a
    // trailing comma. A comma itself is accepted only by a CommaOrEnd state.
    ArrayValueOrEnd,
    ArrayCommaOrEnd,
    ObjectKeyOrEnd,
    ObjectColon,
    ObjectValue,
    ObjectCommaOrEnd,
}

struct Output {
    units: Vec<u16>,
    max_length: usize,
    // Separators only schedule spacing. A subsequent token consumes it, so
    // generated trailing whitespace never counts toward the output limit.
    spacing: Spacing,
}

impl Output {
    fn new(source_length: usize, max_length: usize) -> Self {
        Self {
            units: Vec::with_capacity(source_length.min(max_length)),
            max_length,
            spacing: Spacing::None,
        }
    }

    fn newline(&mut self, depth: usize) {
        self.spacing = if self.units.is_empty() {
            Spacing::None
        } else {
            Spacing::Newline(depth)
        };
    }

    fn append(&mut self, token: &[u16]) -> Result<(), FormatError> {
        let spacing_length = match self.spacing {
            Spacing::None => 0,
            Spacing::Space => 1,
            Spacing::Newline(depth) => depth
                .checked_mul(2)
                .and_then(|indentation| indentation.checked_add(1))
                .ok_or(FormatError::TooLarge)?,
        };
        let length = self
            .units
            .len()
            .checked_add(spacing_length)
            .and_then(|length| length.checked_add(token.len()))
            .filter(|length| *length <= self.max_length)
            .ok_or(FormatError::TooLarge)?;

        if length > self.units.capacity() {
            // Geometric growth keeps repeated appends cheap while ensuring
            // allocation capacity never grows beyond the caller's budget.
            let capacity = self
                .units
                .capacity()
                .saturating_mul(2)
                .max(64)
                .min(self.max_length)
                .max(length);
            self.units.reserve_exact(capacity - self.units.len());
        }

        match self.spacing {
            Spacing::None => {}
            Spacing::Space => self.units.push(u16::from(b' ')),
            Spacing::Newline(_) => {
                self.units.push(u16::from(b'\n'));
                self.units
                    .resize(self.units.len() + spacing_length - 1, u16::from(b' '));
            }
        }
        self.units.extend_from_slice(token);
        self.spacing = Spacing::None;
        Ok(())
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Spacing {
    None,
    Space,
    Newline(usize),
}

#[derive(Clone, Copy)]
struct Token {
    kind: TokenKind,
    // Ranges borrow the original UTF-16 storage so payload tokens never need
    // decoding, normalization, or their own allocation.
    from: usize,
    to: usize,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum TokenKind {
    OpenObject,
    CloseObject,
    OpenArray,
    CloseArray,
    Comma,
    Colon,
    String,
    Number,
    Literal,
    LineComment,
    BlockComment,
}

impl TokenKind {
    fn is_comment(self) -> bool {
        matches!(self, Self::LineComment | Self::BlockComment)
    }

    fn is_opening(self) -> bool {
        matches!(self, Self::OpenObject | Self::OpenArray)
    }

    fn is_closing(self) -> bool {
        matches!(self, Self::CloseObject | Self::CloseArray)
    }
}

struct Tokenizer<'a> {
    source: &'a [u16],
    // The next unread code unit; completed tokens retain their own source range.
    position: usize,
}

impl<'a> Tokenizer<'a> {
    fn new(source: &'a [u16]) -> Self {
        Self {
            source,
            position: 0,
        }
    }

    fn next_token(&mut self) -> Result<Option<Token>, FormatError> {
        while self.position < self.source.len()
            && matches!(self.source[self.position], 0x20 | 0x09 | 0x0a | 0x0d)
        {
            self.position += 1;
        }
        if self.position == self.source.len() {
            return Ok(None);
        }

        let from = self.position;
        let first = self.source[self.position];
        // Every JSON token begins with ASCII; content within strings and
        // comments is checked by their dedicated Unicode-aware scanners below.
        if first > 0x7f {
            return Err(FormatError::Invalid);
        }
        self.position += 1;
        let kind = match first as u8 {
            b'{' => TokenKind::OpenObject,
            b'}' => TokenKind::CloseObject,
            b'[' => TokenKind::OpenArray,
            b']' => TokenKind::CloseArray,
            b',' => TokenKind::Comma,
            b':' => TokenKind::Colon,
            b'"' => self.string()?,
            b'-' | b'0'..=b'9' => self.number(from)?,
            b't' => self.literal("rue")?,
            b'f' => self.literal("alse")?,
            b'n' => self.literal("ull")?,
            b'/' => self.comment()?,
            _ => return Err(FormatError::Invalid),
        };
        Ok(Some(Token {
            kind,
            from,
            to: self.position,
        }))
    }

    fn string(&mut self) -> Result<TokenKind, FormatError> {
        while let Some(&unit) = self.source.get(self.position) {
            self.position += 1;
            match unit {
                0x22 => return Ok(TokenKind::String),
                0x5c => {
                    let escape = *self.source.get(self.position).ok_or(FormatError::Invalid)?;
                    self.position += 1;
                    match escape {
                        0x22 | 0x5c | 0x2f | 0x62 | 0x66 | 0x6e | 0x72 | 0x74 => {}
                        0x75 => {
                            for _ in 0..4 {
                                let hex = self.source.get(self.position);
                                if !hex.is_some_and(
                                    |unit| matches!(*unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66),
                                ) {
                                    return Err(FormatError::Invalid);
                                }
                                self.position += 1;
                            }
                        }
                        _ => return Err(FormatError::Invalid),
                    }
                }
                0..=0x1f => return Err(FormatError::Invalid),
                _ => self.finish_character(unit)?,
            }
        }
        Err(FormatError::Invalid)
    }

    fn number(&mut self, from: usize) -> Result<TokenKind, FormatError> {
        self.position = from;
        self.consume(b'-');
        if !self.consume(b'0') {
            let first = self.source.get(self.position);
            if !first.is_some_and(|unit| matches!(*unit, 0x31..=0x39)) {
                return Err(FormatError::Invalid);
            }
            self.digits();
        }

        if self.consume(b'.') && !self.digits() {
            return Err(FormatError::Invalid);
        }
        if self.consume(b'e') || self.consume(b'E') {
            if !self.consume(b'+') {
                self.consume(b'-');
            }
            if !self.digits() {
                return Err(FormatError::Invalid);
            }
        }
        Ok(TokenKind::Number)
    }

    fn literal(&mut self, suffix: &str) -> Result<TokenKind, FormatError> {
        for ascii in suffix.bytes() {
            if !self.consume(ascii) {
                return Err(FormatError::Invalid);
            }
        }
        Ok(TokenKind::Literal)
    }

    fn comment(&mut self) -> Result<TokenKind, FormatError> {
        if self.consume(b'/') {
            while self.position < self.source.len()
                && !matches!(self.source[self.position], 0x0a | 0x0d)
            {
                let unit = self.source[self.position];
                self.position += 1;
                self.finish_character(unit)?;
            }
            return Ok(TokenKind::LineComment);
        }
        if self.consume(b'*') {
            while self.position < self.source.len() {
                if self.consume(b'*') {
                    if self.consume(b'/') {
                        return Ok(TokenKind::BlockComment);
                    }
                } else {
                    let unit = self.source[self.position];
                    self.position += 1;
                    self.finish_character(unit)?;
                }
            }
        }
        Err(FormatError::Invalid)
    }

    fn finish_character(&mut self, first: u16) -> Result<(), FormatError> {
        // The Lezer grammar describes Unicode scalar values rather than
        // arbitrary raw UTF-16. Escapes are validated separately and may spell
        // any code unit; literal high surrogates must consume a matching low one.
        match first {
            0xd800..=0xdbff => {
                if !self
                    .source
                    .get(self.position)
                    .is_some_and(|unit| matches!(*unit, 0xdc00..=0xdfff))
                {
                    return Err(FormatError::Invalid);
                }
                self.position += 1;
            }
            0xdc00..=0xdfff => return Err(FormatError::Invalid),
            _ => {}
        }
        Ok(())
    }

    fn consume(&mut self, ascii: u8) -> bool {
        if self.source.get(self.position) == Some(&u16::from(ascii)) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self) -> bool {
        let from = self.position;
        while self
            .source
            .get(self.position)
            .is_some_and(|unit| matches!(*unit, 0x30..=0x39))
        {
            self.position += 1;
        }
        self.position != from
    }
}

fn has_newline(source: &[u16]) -> bool {
    source.iter().any(|unit| matches!(*unit, 0x0a | 0x0d))
}

fn is_js_whitespace(unit: u16) -> bool {
    // Matches JavaScript /\s/, which is deliberately broader than JSON's
    // insignificant whitespace when examining the end of a preserved comment.
    matches!(
        unit,
        0x0009..=0x000d
            | 0x0020
            | 0x00a0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

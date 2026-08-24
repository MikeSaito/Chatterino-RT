// MIT reimpl: Chatterino filters/lang/Tokenizer.cpp

use super::types::FilterType;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenType {
    And,
    Or,
    Lp,
    Rp,
    ListStart,
    ListEnd,
    Comma,
    Plus,
    Minus,
    Multiply,
    Divide,
    Mod,
    Eq,
    Neq,
    Lt,
    Gt,
    Lte,
    Gte,
    Contains,
    StartsWith,
    EndsWith,
    Match,
    Not,
    String,
    Int,
    Identifier,
    RegularExpression,
    None,
}

pub static VALID_IDENTIFIERS: &[&str] = &[
    "author.badges",
    "author.external_badges",
    "author.color",
    "author.name",
    "author.user_id",
    "author.no_color",
    "author.subbed",
    "author.sub_length",
    "bits.amount",
    "channel.name",
    "channel.watching",
    "channel.live",
    "flags.action",
    "flags.highlighted",
    "flags.points_redeemed",
    "flags.sub_message",
    "flags.system_message",
    "flags.reward_message",
    "flags.first_message",
    "flags.elevated_message",
    "flags.hype_chat",
    "flags.cheer_message",
    "flags.whisper",
    "flags.reply",
    "flags.automod",
    "flags.restricted",
    "flags.monitored",
    "flags.shared",
    "flags.similar",
    "flags.watch_streak",
    "flags.announcement",
    "message.content",
    "message.length",
    "reward.title",
    "reward.cost",
    "reward.id",
];

fn valid_identifiers() -> HashSet<&'static str> {
    VALID_IDENTIFIERS.iter().copied().collect()
}

pub struct Tokenizer {
    tokens: Vec<String>,
    types: Vec<TokenType>,
    i: usize,
}

impl Tokenizer {
    pub fn new(text: &str) -> Self {
        let re = regex::Regex::new(
            r#"(?x)
            ((?:r|ri)?"(?:\\"|[^"])*")|
            [\w\.]+|
            (?:<=?|>=?|!=?|==|\|\||&&|\+|-|\*|/|%)+|
            [\(\)]
            | [{}]
            | ,
            "#,
        )
        .expect("filter tokenizer regex");
        let mut tokens = Vec::new();
        let mut types = Vec::new();
        for cap in re.find_iter(text) {
            let s = cap.as_str().to_string();
            types.push(tokenize(&s));
            tokens.push(s);
        }
        Self {
            tokens,
            types,
            i: 0,
        }
    }

    pub fn has_next(&self) -> bool {
        self.i < self.tokens.len()
    }

    pub fn next(&mut self) -> &str {
        self.i += 1;
        &self.tokens[self.i - 1]
    }

    pub fn preview(&self) -> &str {
        if self.has_next() {
            &self.tokens[self.i]
        } else {
            ""
        }
    }

    pub fn next_token_type(&self) -> TokenType {
        self.types[self.i]
    }

    pub fn token_type(&self) -> TokenType {
        self.types[self.i - 1]
    }

    pub fn next_token_is_binary_op(&self) -> bool {
        is_binary_op(self.next_token_type())
    }

    pub fn next_token_is_unary_op(&self) -> bool {
        is_unary_op(self.next_token_type())
    }

    pub fn next_token_is_math_op(&self) -> bool {
        is_math_op(self.next_token_type())
    }

    pub fn current(&self) -> &str {
        if self.i > 0 {
            &self.tokens[self.i - 1]
        } else {
            ""
        }
    }

    pub fn next_token_is_op(&self) -> bool {
        let t = self.next_token_type();
        is_binary_op(t) || is_unary_op(t) || is_math_op(t) || t == TokenType::And || t == TokenType::Or
    }
}

fn tokenize(text: &str) -> TokenType {
    match text {
        "&&" => TokenType::And,
        "||" => TokenType::Or,
        "(" => TokenType::Lp,
        ")" => TokenType::Rp,
        "{" => TokenType::ListStart,
        "}" => TokenType::ListEnd,
        "," => TokenType::Comma,
        "+" => TokenType::Plus,
        "-" => TokenType::Minus,
        "*" => TokenType::Multiply,
        "/" => TokenType::Divide,
        "==" => TokenType::Eq,
        "!=" => TokenType::Neq,
        "%" => TokenType::Mod,
        "<" => TokenType::Lt,
        ">" => TokenType::Gt,
        "<=" => TokenType::Lte,
        ">=" => TokenType::Gte,
        "contains" => TokenType::Contains,
        "startswith" => TokenType::StartsWith,
        "endswith" => TokenType::EndsWith,
        "match" => TokenType::Match,
        "!" => TokenType::Not,
        _ => {
            if (text.starts_with("r\"") || text.starts_with("ri\"")) && text.ends_with('"') {
                return TokenType::RegularExpression;
            }
            if text.starts_with('"') && text.ends_with('"') {
                return TokenType::String;
            }
            if valid_identifiers().contains(text) {
                return TokenType::Identifier;
            }
            if text.parse::<i32>().is_ok() {
                return TokenType::Int;
            }
            TokenType::None
        }
    }
}

pub fn is_binary_op(t: TokenType) -> bool {
    matches!(
        t,
        TokenType::Eq
            | TokenType::Neq
            | TokenType::Lt
            | TokenType::Gt
            | TokenType::Lte
            | TokenType::Gte
            | TokenType::Contains
            | TokenType::StartsWith
            | TokenType::EndsWith
            | TokenType::Match
    )
}

pub fn is_unary_op(t: TokenType) -> bool {
    t == TokenType::Not
}

pub fn is_math_op(t: TokenType) -> bool {
    matches!(
        t,
        TokenType::Plus | TokenType::Minus | TokenType::Multiply | TokenType::Divide | TokenType::Mod
    )
}

pub fn identifier_type(name: &str) -> Option<FilterType> {
    match name {
        "author.badges" | "author.external_badges" => Some(FilterType::StringList),
        "author.color" => Some(FilterType::Color),
        "author.name" | "author.user_id" | "channel.name" | "message.content" | "reward.id"
        | "reward.title" => Some(FilterType::String),
        "author.no_color" | "author.subbed" | "channel.watching" | "channel.live"
        | "flags.action" | "flags.highlighted" | "flags.points_redeemed" | "flags.sub_message"
        | "flags.system_message" | "flags.reward_message" | "flags.first_message"
        | "flags.elevated_message" | "flags.hype_chat" | "flags.cheer_message" | "flags.whisper"
        | "flags.reply" | "flags.automod" | "flags.restricted" | "flags.monitored"
        | "flags.shared" | "flags.similar" | "flags.watch_streak" | "flags.announcement" => {
            Some(FilterType::Bool)
        }
        "author.sub_length" | "bits.amount" | "message.length" | "reward.cost" => Some(FilterType::Int),
        _ => None,
    }
}

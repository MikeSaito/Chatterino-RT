// MIT reimpl: Chatterino filters/lang/expressions/*

use super::context::{resolve_identifier, RunContext};
use super::tokenizer::{TokenType, Tokenizer};
use super::types::{is_list, FilterType, FilterValue, PossibleType};

#[derive(Debug, Clone)]
pub enum Expression {
    Value {
        value: FilterValue,
        kind: TokenType,
    },
    Identifier {
        name: String,
        ty: Option<FilterType>,
    },
    Regex {
        pattern: regex::Regex,
        case_insensitive: bool,
    },
    List(Vec<Expression>),
    Unary {
        op: TokenType,
        right: Box<Expression>,
    },
    Binary {
        op: TokenType,
        left: Box<Expression>,
        right: Box<Expression>,
    },
}

impl Expression {
    pub fn execute(&self, ctx: &RunContext<'_>) -> FilterValue {
        match self {
            Self::Value { value, .. } => value.clone(),
            Self::Identifier { name, .. } => resolve_identifier(name, ctx),
            Self::Regex {
                pattern,
                case_insensitive,
            } => FilterValue::Regex {
                pattern: pattern.clone(),
                case_insensitive: *case_insensitive,
            },
            Self::List(items) => {
                let vals: Vec<FilterValue> = items.iter().map(|e| e.execute(ctx)).collect();
                let all_strings = vals.iter().all(|v| matches!(v, FilterValue::String(_)));
                if all_strings {
                    FilterValue::StringList(
                        vals.into_iter()
                            .filter_map(|v| v.as_string())
                            .collect(),
                    )
                } else {
                    FilterValue::List(vals)
                }
            }
            Self::Unary { op, right } => match op {
                TokenType::Not => FilterValue::Bool(!right.execute(ctx).as_bool().unwrap_or(false)),
                _ => FilterValue::Bool(false),
            },
            Self::Binary { op, left, right } => eval_binary(*op, left.execute(ctx), right.execute(ctx)),
        }
    }

    pub fn synthesize_type(&self) -> PossibleType {
        match self {
            Self::Value { kind, .. } => match kind {
                TokenType::Int => PossibleType::Typed(FilterType::Int),
                TokenType::String => PossibleType::Typed(FilterType::String),
                _ => PossibleType::IllTyped,
            },
            Self::Identifier { ty, .. } => ty
                .map(PossibleType::Typed)
                .unwrap_or(PossibleType::IllTyped),
            Self::Regex { .. } => PossibleType::Typed(FilterType::RegularExpression),
            Self::List(items) => {
                let mut all_strings = true;
                for item in items {
                    let t = item.synthesize_type();
                    if t == PossibleType::IllTyped {
                        return PossibleType::IllTyped;
                    }
                    if t != PossibleType::Typed(FilterType::String) {
                        all_strings = false;
                    }
                }
                if items.len() == 2 {
                    let t0 = items[0].synthesize_type();
                    let t1 = items[1].synthesize_type();
                    if t0 == PossibleType::Typed(FilterType::RegularExpression)
                        && t1 == PossibleType::Typed(FilterType::Int)
                    {
                        return PossibleType::Typed(FilterType::MatchingSpecifier);
                    }
                }
                if all_strings {
                    PossibleType::Typed(FilterType::StringList)
                } else {
                    PossibleType::Typed(FilterType::List)
                }
            }
            Self::Unary { op, right } => {
                let rt = right.synthesize_type();
                if op == &TokenType::Not && rt == PossibleType::Typed(FilterType::Bool) {
                    PossibleType::Typed(FilterType::Bool)
                } else {
                    PossibleType::IllTyped
                }
            }
            Self::Binary { op, left, right } => synth_binary(*op, left.synthesize_type(), right.synthesize_type()),
        }
    }
}

fn synth_binary(op: TokenType, left: PossibleType, right: PossibleType) -> PossibleType {
    if left == PossibleType::IllTyped || right == PossibleType::IllTyped {
        return PossibleType::IllTyped;
    }
    let l = match left {
        PossibleType::Typed(t) => t,
        _ => return PossibleType::IllTyped,
    };
    let r = match right {
        PossibleType::Typed(t) => t,
        _ => return PossibleType::IllTyped,
    };
    match op {
        TokenType::Plus if l == FilterType::String => PossibleType::Typed(FilterType::String),
        TokenType::Plus | TokenType::Minus | TokenType::Multiply | TokenType::Divide | TokenType::Mod
            if l == FilterType::Int && r == FilterType::Int =>
        {
            PossibleType::Typed(FilterType::Int)
        }
        TokenType::And | TokenType::Or
            if l == FilterType::Bool && r == FilterType::Bool =>
        {
            PossibleType::Typed(FilterType::Bool)
        }
        TokenType::Eq | TokenType::Neq => PossibleType::Typed(FilterType::Bool),
        TokenType::Lt | TokenType::Gt | TokenType::Lte | TokenType::Gte
            if l == FilterType::Int && r == FilterType::Int =>
        {
            PossibleType::Typed(FilterType::Bool)
        }
        TokenType::Contains | TokenType::StartsWith | TokenType::EndsWith
            if is_list(left) || (l == FilterType::String && r == FilterType::String) =>
        {
            PossibleType::Typed(FilterType::Bool)
        }
        TokenType::Match if l == FilterType::String
            && (r == FilterType::RegularExpression || r == FilterType::MatchingSpecifier) =>
        {
            if r == FilterType::MatchingSpecifier {
                PossibleType::Typed(FilterType::String)
            } else {
                PossibleType::Typed(FilterType::Bool)
            }
        }
        _ => PossibleType::IllTyped,
    }
}

fn eval_binary(op: TokenType, left: FilterValue, right: FilterValue) -> FilterValue {
    match op {
        TokenType::Plus => {
            if let (Some(a), Some(b)) = (left.as_string(), right.as_string()) {
                return FilterValue::String(format!("{a}{b}"));
            }
            if let (Some(a), Some(b)) = (left.as_int(), right.as_int()) {
                return FilterValue::Int(a + b);
            }
            FilterValue::Int(0)
        }
        TokenType::Minus => int_bin(left, right, |a, b| a - b),
        TokenType::Multiply => int_bin(left, right, |a, b| a * b),
        TokenType::Divide => int_bin(left, right, int_div),
        TokenType::Mod => int_bin(left, right, int_mod),
        TokenType::Or => bool_bin(left, right, |a, b| a || b),
        TokenType::And => bool_bin(left, right, |a, b| a && b),
        TokenType::Eq => FilterValue::Bool(values_equal(left, right)),
        TokenType::Neq => FilterValue::Bool(!values_equal(left, right)),
        TokenType::Lt => cmp_int(left, right, |a, b| a < b),
        TokenType::Gt => cmp_int(left, right, |a, b| a > b),
        TokenType::Lte => cmp_int(left, right, |a, b| a <= b),
        TokenType::Gte => cmp_int(left, right, |a, b| a >= b),
        TokenType::Contains => eval_contains(left, right),
        TokenType::StartsWith => eval_starts_with(left, right),
        TokenType::EndsWith => eval_ends_with(left, right),
        TokenType::Match => eval_match(left, right),
        _ => FilterValue::Bool(false),
    }
}

fn int_bin(left: FilterValue, right: FilterValue, f: fn(i32, i32) -> i32) -> FilterValue {
    match (left.as_int(), right.as_int()) {
        (Some(a), Some(b)) => FilterValue::Int(f(a, b)),
        _ => FilterValue::Int(0),
    }
}

fn int_div(a: i32, b: i32) -> i32 {
    if b == 0 {
        0
    } else {
        a / b
    }
}

fn int_mod(a: i32, b: i32) -> i32 {
    if b == 0 {
        0
    } else {
        a % b
    }
}

fn bool_bin(left: FilterValue, right: FilterValue, f: fn(bool, bool) -> bool) -> FilterValue {
    match (left.as_bool(), right.as_bool()) {
        (Some(a), Some(b)) => FilterValue::Bool(f(a, b)),
        _ => FilterValue::Bool(false),
    }
}

fn cmp_int(left: FilterValue, right: FilterValue, f: fn(i32, i32) -> bool) -> FilterValue {
    match (left.as_int(), right.as_int()) {
        (Some(a), Some(b)) => FilterValue::Bool(f(a, b)),
        _ => FilterValue::Bool(false),
    }
}

fn values_equal(mut left: FilterValue, mut right: FilterValue) -> bool {
    if let (Some(a), Some(b)) = (left.as_string(), right.as_string()) {
        return a.eq_ignore_ascii_case(&b);
    }
    if let FilterValue::Color(c) = &left {
        if let Some(b) = right.as_string() {
            return c.eq_ignore_ascii_case(&b);
        }
    }
    if let FilterValue::Color(c) = &right {
        if let Some(a) = left.as_string() {
            return a.eq_ignore_ascii_case(c);
        }
    }
    coerce_equal(&mut left, &mut right)
}

fn coerce_equal(left: &mut FilterValue, right: &mut FilterValue) -> bool {
    if let (Some(a), Some(b)) = (left.as_int(), right.as_string()) {
        return b.parse::<i32>().ok() == Some(a);
    }
    if let (Some(a), Some(b)) = (left.as_string(), right.as_int()) {
        return a.parse::<i32>().ok() == Some(b);
    }
    match (left, right) {
        (FilterValue::Int(a), FilterValue::Int(b)) => a == b,
        (FilterValue::Bool(a), FilterValue::Bool(b)) => a == b,
        _ => false,
    }
}

fn ci_contains(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

fn eval_contains(left: FilterValue, right: FilterValue) -> FilterValue {
    if let (Some(list), Some(needle)) = (left.as_string_list(), right.as_string()) {
        return FilterValue::Bool(
            list.iter().any(|s| s.eq_ignore_ascii_case(&needle)),
        );
    }
    if let (Some(list), Some(needle)) = (left.as_list(), right.as_string()) {
        return FilterValue::Bool(
            list.iter().any(|v| v.as_string().as_deref() == Some(needle.as_str())),
        );
    }
    if let (Some(a), Some(b)) = (left.as_string(), right.as_string()) {
        return FilterValue::Bool(ci_contains(&a, &b));
    }
    FilterValue::Bool(false)
}

fn eval_starts_with(left: FilterValue, right: FilterValue) -> FilterValue {
    if let (Some(list), Some(needle)) = (left.as_string_list(), right.as_string()) {
        return FilterValue::Bool(
            list.first()
                .is_some_and(|s| s.eq_ignore_ascii_case(&needle)),
        );
    }
    if let (Some(list), Some(needle)) = (left.as_list(), right.as_string()) {
        return FilterValue::Bool(
            list.first()
                .and_then(|v| v.as_string())
                .is_some_and(|s| s == needle),
        );
    }
    if let (Some(a), Some(b)) = (left.as_string(), right.as_string()) {
        return FilterValue::Bool(a.to_ascii_lowercase().starts_with(&b.to_ascii_lowercase()));
    }
    FilterValue::Bool(false)
}

fn eval_ends_with(left: FilterValue, right: FilterValue) -> FilterValue {
    if let (Some(list), Some(needle)) = (left.as_string_list(), right.as_string()) {
        return FilterValue::Bool(
            list.last()
                .is_some_and(|s| s.eq_ignore_ascii_case(&needle)),
        );
    }
    if let (Some(list), Some(needle)) = (left.as_list(), right.as_string()) {
        return FilterValue::Bool(
            list.last()
                .and_then(|v| v.as_string())
                .is_some_and(|s| s == needle),
        );
    }
    if let (Some(a), Some(b)) = (left.as_string(), right.as_string()) {
        return FilterValue::Bool(a.to_ascii_lowercase().ends_with(&b.to_ascii_lowercase()));
    }
    FilterValue::Bool(false)
}

fn eval_match(left: FilterValue, right: FilterValue) -> FilterValue {
    let Some(hay) = left.as_string() else {
        return FilterValue::Bool(false);
    };
    if let Some(re) = right.as_regex() {
        return FilterValue::Bool(re.is_match(&hay));
    }
    if let FilterValue::List(items) = right {
        if items.len() != 2 {
            return FilterValue::Bool(false);
        }
        let re_val = &items[0];
        let idx_val = &items[1];
        let Some(re) = re_val.as_regex() else {
            return FilterValue::String(String::new());
        };
        let Some(idx) = idx_val.as_int() else {
            return FilterValue::String(String::new());
        };
        if let Some(caps) = re.captures(&hay) {
            return FilterValue::String(
                caps.get(idx as usize)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default(),
            );
        }
        return FilterValue::String(String::new());
    }
    FilterValue::Bool(false)
}

pub fn try_compile_regex(
    pattern: &str,
    case_insensitive: bool,
) -> Result<regex::Regex, regex::Error> {
    if case_insensitive {
        regex::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
    } else {
        regex::Regex::new(pattern)
    }
}

pub struct FilterParser {
    tokenizer: Tokenizer,
    valid: bool,
    return_type: FilterType,
    built: Option<Expression>,
    errors: Vec<String>,
}

impl FilterParser {
    pub fn new(text: &str) -> Self {
        let mut parser = Self {
            tokenizer: Tokenizer::new(text),
            valid: true,
            return_type: FilterType::Bool,
            built: None,
            errors: Vec::new(),
        };
        let expr = parser.parse_expression(true);
        if !parser.valid {
            return parser;
        }
        let rt = expr.synthesize_type();
        if rt == PossibleType::IllTyped {
            parser.error("Type check failed");
            return parser;
        }
        parser.return_type = match rt {
            PossibleType::Typed(t) => t,
            _ => FilterType::Bool,
        };
        parser.built = Some(expr);
        parser
    }

    pub fn valid(&self) -> bool {
        self.valid
    }

    pub fn return_type(&self) -> FilterType {
        self.return_type
    }

    pub fn release(self) -> Option<Expression> {
        self.built
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    fn error(&mut self, text: impl Into<String>) {
        self.valid = false;
        if self.errors.is_empty() {
            self.errors.push(text.into());
        }
    }

    fn parse_expression(&mut self, top: bool) -> Expression {
        let mut e = self.parse_and();
        while self.tokenizer.has_next() && self.tokenizer.next_token_type() == TokenType::Or {
            self.tokenizer.next();
            let next = self.parse_and();
            e = Expression::Binary {
                op: TokenType::Or,
                left: Box::new(e),
                right: Box::new(next),
            };
        }
        if self.tokenizer.has_next() && top {
            self.error(format!(
                "Unexpected token at end: {}",
                self.tokenizer.preview()
            ));
        }
        e
    }

    fn parse_and(&mut self) -> Expression {
        let mut e = self.parse_unary();
        while self.tokenizer.has_next() && self.tokenizer.next_token_type() == TokenType::And {
            self.tokenizer.next();
            let next = self.parse_unary();
            e = Expression::Binary {
                op: TokenType::And,
                left: Box::new(e),
                right: Box::new(next),
            };
        }
        e
    }

    fn parse_unary(&mut self) -> Expression {
        if self.tokenizer.has_next() && self.tokenizer.next_token_is_unary_op() {
            self.tokenizer.next();
            let op = self.tokenizer.token_type();
            let next = self.parse_condition();
            return Expression::Unary {
                op,
                right: Box::new(next),
            };
        }
        self.parse_condition()
    }

    fn parse_condition(&mut self) -> Expression {
        let mut value = if self.tokenizer.has_next()
            && self.tokenizer.next_token_type() == TokenType::Lp
        {
            self.parse_parentheses()
        } else {
            self.parse_value()
        };

        loop {
            if !self.tokenizer.has_next() {
                break;
            }
            if self.tokenizer.next_token_is_binary_op() {
                self.tokenizer.next();
                let op = self.tokenizer.token_type();
                let next = self.parse_value();
                return Expression::Binary {
                    op,
                    left: Box::new(value),
                    right: Box::new(next),
                };
            }
            if self.tokenizer.next_token_is_math_op() {
                self.tokenizer.next();
                let op = self.tokenizer.token_type();
                let next = self.parse_value();
                value = Expression::Binary {
                    op,
                    left: Box::new(value),
                    right: Box::new(next),
                };
            } else if self.tokenizer.next_token_type() == TokenType::Rp {
                break;
            } else if !self.tokenizer.next_token_is_op() {
                self.error(format!(
                    "Expected an operator but got {}",
                    self.tokenizer.preview()
                ));
                break;
            } else {
                break;
            }
        }
        value
    }

    fn parse_parentheses(&mut self) -> Expression {
        assert_eq!(self.tokenizer.next_token_type(), TokenType::Lp);
        self.tokenizer.next();
        let e = self.parse_expression(false);
        if self.tokenizer.has_next() && self.tokenizer.next_token_type() == TokenType::Rp {
            self.tokenizer.next();
            e
        } else {
            let msg = if self.tokenizer.has_next() {
                format!("Missing closing parentheses: got {}", self.tokenizer.preview())
            } else {
                "Missing closing parentheses at end of statement".into()
            };
            self.error(msg);
            e
        }
    }

    fn parse_value(&mut self) -> Expression {
        if !self.tokenizer.has_next() {
            self.error("Unexpected end of statement");
            return Expression::Value {
                value: FilterValue::Int(0),
                kind: TokenType::Int,
            };
        }
        let ty = self.tokenizer.next_token_type();
        match ty {
            TokenType::Int => {
                let raw = self.tokenizer.next();
                Expression::Value {
                    value: FilterValue::Int(raw.parse().unwrap_or(0)),
                    kind: TokenType::Int,
                }
            }
            TokenType::String => {
                let raw = self.tokenizer.next();
                let val = raw[1..raw.len() - 1].replace("\\\"", "\"");
                Expression::Value {
                    value: FilterValue::String(val.clone()),
                    kind: TokenType::String,
                }
            }
            TokenType::Identifier => {
                let name = self.tokenizer.next().to_string();
                let ty = super::context::identifier_return_type(&name);
                Expression::Identifier { name, ty }
            }
            TokenType::RegularExpression => {
                let raw = self.tokenizer.next();
                let ci = raw.starts_with("ri");
                let val = raw[if ci { 3 } else { 2 }..raw.len() - 1].replace("\\\"", "\"");
                match try_compile_regex(&val, ci) {
                    Ok(re) => Expression::Regex {
                        pattern: re,
                        case_insensitive: ci,
                    },
                    Err(e) => {
                        self.error(format!("Invalid regular expression: {e}"));
                        Expression::Value {
                            value: FilterValue::Int(0),
                            kind: TokenType::Int,
                        }
                    }
                }
            }
            TokenType::Lp => self.parse_parentheses(),
            TokenType::ListStart => self.parse_list(),
            _ => {
                let bad = self.tokenizer.preview().to_string();
                if self.tokenizer.has_next() {
                    self.tokenizer.next();
                }
                self.error(format!("Expected value but got {bad}"));
                Expression::Value {
                    value: FilterValue::Int(0),
                    kind: TokenType::Int,
                }
            }
        }
    }

    fn parse_list(&mut self) -> Expression {
        assert_eq!(self.tokenizer.next_token_type(), TokenType::ListStart);
        self.tokenizer.next();
        let mut list = Vec::new();
        let mut first = true;
        while self.tokenizer.has_next() {
            if self.tokenizer.next_token_type() == TokenType::ListEnd {
                self.tokenizer.next();
                return Expression::List(list);
            }
            if self.tokenizer.next_token_type() == TokenType::Comma && !first {
                self.tokenizer.next();
                list.push(self.parse_value());
                first = false;
            } else if first {
                list.push(self.parse_value());
                first = false;
            } else {
                break;
            }
        }
        let msg = if self.tokenizer.has_next() {
            format!(
                "Missing closing list braces: got {}",
                self.tokenizer.preview()
            )
        } else {
            "Missing closing list braces at end of statement".into()
        };
        self.error(msg);
        Expression::List(Vec::new())
    }
}

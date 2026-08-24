// MIT reimpl: Chatterino filters/lang/Types.hpp

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterType {
    String,
    Int,
    Bool,
    Color,
    RegularExpression,
    List,
    StringList,
    MatchingSpecifier,
}

#[derive(Debug, Clone)]
pub enum FilterValue {
    Int(i32),
    Bool(bool),
    String(String),
    Color(String),
    StringList(Vec<String>),
    List(Vec<FilterValue>),
    Regex {
        pattern: regex::Regex,
        case_insensitive: bool,
    },
}

impl FilterValue {
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i32> {
        match self {
            Self::Int(v) => Some(*v),
            _ => None,
        }
    }

    pub fn as_string(&self) -> Option<String> {
        match self {
            Self::String(v) => Some(v.clone()),
            Self::Color(v) => Some(v.clone()),
            _ => None,
        }
    }

    pub fn as_string_list(&self) -> Option<Vec<String>> {
        match self {
            Self::StringList(v) => Some(v.clone()),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<Vec<FilterValue>> {
        match self {
            Self::List(v) => Some(v.clone()),
            Self::StringList(v) => Some(v.iter().cloned().map(FilterValue::String).collect()),
            _ => None,
        }
    }

    pub fn as_regex(&self) -> Option<&regex::Regex> {
        match self {
            Self::Regex { pattern, .. } => Some(pattern),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PossibleType {
    Typed(FilterType),
    IllTyped,
}

pub fn is_list(ty: PossibleType) -> bool {
    matches!(
        ty,
        PossibleType::Typed(FilterType::List)
            | PossibleType::Typed(FilterType::StringList)
            | PossibleType::Typed(FilterType::MatchingSpecifier)
    )
}

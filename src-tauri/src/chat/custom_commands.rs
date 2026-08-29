// MIT reimpl: Chatterino CommandController::execCustomCommand + user command match.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use super::settings::CommandRow;

const MAX_EXPANSION_PASSES: usize = 2;
pub const MAX_COMMAND_FIELD_CHARS: usize = 500;

#[derive(Debug, Clone, Default)]
pub struct CustomCommandSet {
    commands: HashMap<String, String>,
    menu_triggers: HashSet<String>,
    max_spaces: usize,
    triggers: Vec<String>,
}

impl CustomCommandSet {
    pub fn compile(rows: &[CommandRow]) -> Self {
        let mut commands = HashMap::new();
        let mut menu_triggers = HashSet::new();
        let mut max_spaces = 0;
        let mut triggers = Vec::new();
        for row in rows {
            let trigger = row.trigger.trim();
            if trigger.is_empty() {
                continue;
            }
            let spaces = trigger.chars().filter(|c| *c == ' ').count();
            max_spaces = max_spaces.max(spaces);
            if row.show_in_message_menu {
                menu_triggers.insert(trigger.to_string());
            }
            if !commands.contains_key(trigger) {
                triggers.push(trigger.to_string());
                commands.insert(trigger.to_string(), row.command.clone());
            }
        }
        triggers.sort();
        Self {
            commands,
            menu_triggers,
            max_spaces,
            triggers,
        }
    }

    pub fn allows_menu_trigger(&self, trigger: &str) -> bool {
        self.menu_triggers.contains(trigger.trim())
    }

    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    pub fn triggers(&self) -> &[String] {
        &self.triggers
    }

    pub fn template(&self, trigger: &str) -> Option<&str> {
        self.commands.get(trigger).map(|s| s.as_str())
    }

    pub fn match_trigger<'a>(&'a self, words: &[String]) -> Option<&'a str> {
        if words.is_empty() {
            return None;
        }
        let mut command_name = words[0].clone();
        if let Some(t) = self.commands.get(&command_name) {
            return Some(t.as_str());
        }
        let limit = self.max_spaces.min(words.len().saturating_sub(1));
        for i in 0..limit {
            command_name.push(' ');
            command_name.push_str(&words[i + 1]);
            if let Some(t) = self.commands.get(&command_name) {
                return Some(t.as_str());
            }
        }
        None
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExpandContext {
    pub channel: String,
    pub room_id: Option<String>,
    pub channel_live: bool,
    pub my_login: Option<String>,
    pub my_user_id: Option<String>,
    pub stream_game: Option<String>,
    pub stream_title: Option<String>,
    pub message_login: Option<String>,
    pub message_display: Option<String>,
    pub message_id: Option<String>,
    pub message_text: Option<String>,
    pub input_text: Option<String>,
    pub copy_text: Option<String>,
}

pub fn split_words(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_string).collect()
}

pub fn resolve_user_commands(set: &CustomCommandSet, text: &str, ctx: &ExpandContext) -> String {
    let mut current = text.to_string();
    for _ in 0..MAX_EXPANSION_PASSES {
        let words = split_words(&current);
        let Some(template) = set.match_trigger(&words) else {
            break;
        };
        current = expand(template, &words, ctx);
    }
    current
}

pub fn expand_menu_command(
    set: &CustomCommandSet,
    trigger: &str,
    message_text: &str,
    ctx: &ExpandContext,
) -> Option<String> {
    let template = set.template(trigger.trim())?;
    let mut input = trigger.trim().to_string();
    if !message_text.trim().is_empty() {
        if !input.is_empty() {
            input.push(' ');
        }
        input.push_str(message_text.trim());
    }
    let words = split_words(&input);
    let mut text = expand(template, &words, ctx);
    text = resolve_user_commands(set, &text, ctx);
    Some(text)
}

pub fn expand(template: &str, words: &[String], ctx: &ExpandContext) -> String {
    let re = expand_regex();
    let mut result = String::new();
    let mut last_end = 0usize;
    for caps in re.captures_iter(template) {
        let m = caps.get(0).expect("full match");
        let prefix_len =
            caps.get(1).map(|c| c.len()).unwrap_or(0) + caps.get(2).map(|c| c.len()).unwrap_or(0);
        let prefix_end = m.start() + prefix_len;
        result.push_str(&template[last_end..prefix_end]);
        last_end = m.end();

        let word_index_match = caps.get(3).map(|c| c.as_str()).unwrap_or("");
        let plus = word_index_match.ends_with('+');
        let index_raw = word_index_match.trim_end_matches('+');
        if let Ok(word_index) = index_raw.parse::<usize>() {
            if word_index == 0 {
                result.push_str(&format!("{{{word_index_match}}}"));
            } else if word_index < words.len() {
                if plus {
                    result.push_str(&words[word_index..].join(" "));
                } else {
                    result.push_str(&words[word_index]);
                }
            }
        } else {
            let var_name = caps.get(4).map(|c| c.as_str()).unwrap_or("");
            let alt = caps.get(5).map(|c| c.as_str()).unwrap_or("");
            result.push_str(&resolve_var(var_name, alt, ctx));
        }
    }
    result.push_str(&template[last_end..]);
    if result.starts_with('{') {
        result = result[1..].to_string();
    }
    result.replace("{{", "{")
}

fn resolve_var(name: &str, alt: &str, ctx: &ExpandContext) -> String {
    match name {
        "input.text" => opt_or_alt(ctx.input_text.as_deref(), alt),
        "element.copytext" => opt_or_alt(ctx.copy_text.as_deref(), alt),
        "channel.name" | "channel" => {
            if ctx.channel.is_empty() {
                alt.to_string()
            } else {
                ctx.channel.clone()
            }
        }
        "channel.id" => opt_or_alt(ctx.room_id.as_deref(), alt),
        "my.name" => opt_or_alt(ctx.my_login.as_deref(), alt),
        "my.id" => opt_or_alt(ctx.my_user_id.as_deref(), alt),
        "user.name" | "user" => opt_or_alt(ctx.message_login.as_deref(), alt),
        "stream.game" => {
            if ctx.channel_live {
                ctx.stream_game.clone().unwrap_or_default()
            } else {
                alt.to_string()
            }
        }
        "stream.title" => {
            if ctx.channel_live {
                ctx.stream_title.clone().unwrap_or_default()
            } else {
                alt.to_string()
            }
        }
        "msg.id" | "msg-id" => opt_or_alt(ctx.message_id.as_deref(), alt),
        "msg.text" | "message" => opt_or_alt(ctx.message_text.as_deref(), alt),
        _ => {
            if name.is_empty() {
                alt.to_string()
            } else {
                format!("{{{name}}}")
            }
        }
    }
}

fn opt_or_alt(value: Option<&str>, alt: &str) -> String {
    value.filter(|s| !s.is_empty()).unwrap_or(alt).to_string()
}

fn expand_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(^|[^{])(\{\{)*\{(\d+\+?|([a-zA-Z.-]+)(?:;(.+?))?)\}")
            .expect("custom command expand regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ExpandContext {
        ExpandContext {
            channel: "xqc".into(),
            room_id: Some("12345".into()),
            channel_live: true,
            my_login: Some("me".into()),
            my_user_id: Some("999".into()),
            stream_game: Some("Just Chatting".into()),
            stream_title: Some("Ranked".into()),
            message_login: Some("viewer".into()),
            message_display: Some("Viewer".into()),
            message_id: Some("abc".into()),
            message_text: Some("hello world".into()),
            input_text: Some("composer".into()),
            copy_text: Some("copy".into()),
        }
    }

    #[test]
    fn word_index_and_plus() {
        let words = vec!["/shout".into(), "one".into(), "two".into(), "three".into()];
        assert_eq!(expand("/me {1}", &words, &ctx()), "/me one");
        assert_eq!(expand("args {2+}", &words, &ctx()), "args two three");
    }

    #[test]
    fn vars_and_alt() {
        let c = ctx();
        assert_eq!(expand("{user.name}", &[], &c), "viewer");
        assert_eq!(
            expand("{user.name;fallback}", &[], &ExpandContext::default()),
            "fallback"
        );
        assert_eq!(expand("{channel.name}", &[], &c), "xqc");
        assert_eq!(expand("{stream.game}", &[], &c), "Just Chatting");
        assert_eq!(expand("{input.text}", &[], &c), "composer");
        assert_eq!(expand("{element.copytext}", &[], &c), "copy");
    }

    #[test]
    fn escape_braces() {
        assert_eq!(
            expand("before {{ after", &[], &ExpandContext::default()),
            "before { after"
        );
    }

    #[test]
    fn match_multi_word_trigger() {
        let set = CustomCommandSet::compile(&[CommandRow {
            trigger: "hello world".into(),
            command: "hi {2}".into(),
            show_in_message_menu: false,
        }]);
        let words = vec!["hello".into(), "world".into(), "there".into()];
        assert_eq!(set.match_trigger(&words), Some("hi {2}"));
    }

    #[test]
    fn resolve_user_commands_chain() {
        let set = CustomCommandSet::compile(&[
            CommandRow {
                trigger: "/a".into(),
                command: "/b {1}".into(),
                show_in_message_menu: false,
            },
            CommandRow {
                trigger: "/b".into(),
                command: "hello {1}".into(),
                show_in_message_menu: false,
            },
        ]);
        let out = resolve_user_commands(&set, "/a x", &ExpandContext::default());
        assert_eq!(out, "hello x");
    }

    #[test]
    fn menu_command_builds_words_from_message() {
        let set = CustomCommandSet::compile(&[CommandRow {
            trigger: "/greet".into(),
            command: "/me says hi to {user.name}: {2}".into(),
            show_in_message_menu: true,
        }]);
        let c = ctx();
        let out = expand_menu_command(&set, "/greet", "ignored tail", &c).unwrap();
        assert!(out.contains("viewer"));
    }
}

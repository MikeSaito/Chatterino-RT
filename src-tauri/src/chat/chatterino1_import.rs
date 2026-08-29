//! Chatterino 1 custom commands import (`%APPDATA%\\Chatterino\\Custom\\Commands.txt`).
//! Reimplementation of stock CommandPage importer; not a port.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::custom_commands::MAX_COMMAND_FIELD_CHARS;
use super::settings::CommandRow;

const RELATIVE: &str = "Chatterino/Custom/Commands.txt";

pub fn chatterino1_commands_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA")?;
        let base = PathBuf::from(appdata);
        let path = base.join(RELATIVE.replace('/', "\\"));
        Some(path)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn path_allowed(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let appdata = match std::env::var_os("APPDATA") {
            Some(v) => PathBuf::from(v),
            None => return false,
        };
        let expected = appdata.join(RELATIVE.replace('/', "\\"));
        let Ok(canonical) = path.canonicalize() else {
            return false;
        };
        let Ok(expected_canonical) = expected.canonicalize() else {
            return canonical == expected;
        };
        canonical == expected_canonical
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

pub fn chatterino1_commands_available() -> bool {
    let Some(path) = chatterino1_commands_path() else {
        return false;
    };
    path.is_file() && path_allowed(&path)
}

pub fn parse_chatterino1_commands_text(text: &str) -> Vec<CommandRow> {
    let mut by_trigger: HashMap<String, CommandRow> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((trigger, command)) = split_trigger_command(line) else {
            continue;
        };
        if trigger.is_empty() || command.is_empty() {
            continue;
        }
        if trigger.chars().count() > MAX_COMMAND_FIELD_CHARS
            || command.chars().count() > MAX_COMMAND_FIELD_CHARS
        {
            continue;
        }
        by_trigger.insert(
            trigger.clone(),
            CommandRow {
                trigger,
                command,
                show_in_message_menu: false,
            },
        );
    }
    let mut out: Vec<CommandRow> = by_trigger.into_values().collect();
    out.sort_by(|a, b| a.trigger.cmp(&b.trigger));
    out
}

fn split_trigger_command(line: &str) -> Option<(String, String)> {
    let idx = line.find(' ')?;
    let trigger = line[..idx].trim().to_string();
    let command = line[idx + 1..].trim().to_string();
    Some((trigger, command))
}

pub fn read_chatterino1_commands() -> Result<Vec<CommandRow>, String> {
    let Some(path) = chatterino1_commands_path() else {
        return Err("Chatterino 1 commands are only available on Windows".into());
    };
    if !path.is_file() {
        return Err("Chatterino 1 commands file not found".into());
    }
    if !path_allowed(&path) {
        return Err("Invalid Chatterino 1 commands path".into());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    Ok(parse_chatterino1_commands_text(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lines_and_dedupe_trigger() {
        let text = "/foo bar baz\n/foo replaced\n\n  /me  action text  \n";
        let rows = parse_chatterino1_commands_text(text);
        assert_eq!(rows.len(), 2);
        let foo = rows.iter().find(|r| r.trigger == "/foo").expect("foo");
        assert_eq!(foo.command, "replaced");
        assert!(!foo.show_in_message_menu);
        let me = rows.iter().find(|r| r.trigger == "/me").expect("me");
        assert_eq!(me.command, "action text");
    }

    #[test]
    fn skip_oversize_fields() {
        let trigger = "a".repeat(MAX_COMMAND_FIELD_CHARS + 1);
        let text = format!("{trigger} body");
        assert!(parse_chatterino1_commands_text(&text).is_empty());
    }

    #[test]
    fn skip_line_without_space() {
        assert!(parse_chatterino1_commands_text("nospacetrigger").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn path_under_appdata() {
        let Some(path) = chatterino1_commands_path() else {
            return;
        };
        assert!(path.to_string_lossy().contains("Chatterino"));
    }
}

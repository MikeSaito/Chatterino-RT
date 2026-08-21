/** Chatterino formatUserMention — comma only for first word when enabled. */

export function formatUserMention(
  userName: string,
  isFirstWord: boolean,
  mentionUsersWithComma: boolean,
): string {
  const name = userName.trim();
  if (!name) {
    return "";
  }
  if (isFirstWord && mentionUsersWithComma) {
    return `${name},`;
  }
  return name;
}

export function mentionInsertText(
  login: string,
  isFirstWord: boolean,
  mentionUsersWithComma: boolean,
): string {
  const core = formatUserMention(login, isFirstWord, mentionUsersWithComma);
  return core ? `@${core} ` : "";
}

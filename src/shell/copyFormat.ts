/** Stock CopyMode::EverythingButReplies — timestamp + nick + body, без reply-header. */
export function formatFullCopyText(input: {
  time: string;
  nick: string;
  body: string;
  copyText: string;
  system: boolean;
  isAction?: boolean;
  isWhisper?: boolean;
  /** Self login for incoming whisper copy (sender->self: text). */
  whisperPeer?: string;
}): string {
  const time = input.time.trim();
  const nick = input.nick.trim();
  const body = input.body.trim();
  const copyText = input.copyText.trim();

  if (input.system) {
    if (nick && nick !== "*") {
      if (time && body) {
        return `${time} ${nick}: ${body}`;
      }
      if (time) {
        return `${time} ${nick}`;
      }
      if (body) {
        return `${nick}: ${body}`;
      }
      return nick;
    }
    if (time && body) {
      return `${time} ${body}`;
    }
    return time || body;
  }

  if (input.isWhisper && nick && copyText) {
    const peer = input.whisperPeer?.trim();
    const line = peer ? `${nick}->${peer}: ${copyText}` : `${nick}: ${copyText}`;
    return time ? `${time} ${line}` : line;
  }

  if (input.isAction && nick && copyText) {
    return time ? `${time} ${nick} ${copyText}` : `${nick} ${copyText}`;
  }

  if (nick && body) {
    return time ? `${time} ${nick}: ${body}` : `${nick}: ${body}`;
  }
  if (nick) {
    return time ? `${time} ${nick}` : nick;
  }
  return time ? (body ? `${time} ${body}` : time) : body;
}

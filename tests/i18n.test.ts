import { en } from "../src/i18n/en.ts";
import { ru } from "../src/i18n/ru.ts";
import { settingsEn } from "../src/i18n/settings.en.ts";
import { settingsRu } from "../src/i18n/settings.ru.ts";
import {
  applyLocale,
  getLocale,
  parseLocale,
  setLocale,
  t,
} from "../src/i18n/index.ts";
import { tKnobLabel, tPageNav } from "../src/i18n/settingsT.ts";
import { formatInvokeError } from "../src/i18n/formatError.ts";
import {
  clearchatText,
  deletionNoticeText,
  formatReplyHeader,
  whisperPrefix,
} from "../src/chat/chatSystemText.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function assertKeyParity(
  a: Record<string, string>,
  b: Record<string, string>,
  label: string,
): void {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  assert(
    aKeys.length === bKeys.length,
    `${label} key count en=${aKeys.length} ru=${bKeys.length}`,
  );
  for (let i = 0; i < aKeys.length; i += 1) {
    assert(
      aKeys[i] === bKeys[i],
      `${label} key mismatch at ${i}: ${aKeys[i]} vs ${bKeys[i]}`,
    );
  }
}

assert(parseLocale("ru") === "ru", "parse ru");
assert(parseLocale("RU-ru") === "ru", "parse RU-ru");
assert(parseLocale("en") === "en", "parse en");
assert(parseLocale("") === "en", "parse empty → en");
assert(parseLocale(undefined) === "en", "parse undef → en");

assertKeyParity(en as Record<string, string>, ru as Record<string, string>, "chrome");
assertKeyParity(settingsEn, settingsRu, "settings catalog");
assert(
  Object.keys(settingsEn).length > 100,
  `settings catalog expected many keys, got ${Object.keys(settingsEn).length}`,
);

setLocale("en");
assert(getLocale() === "en", "locale en");
assert(t("auth.signin") === "Log in", "en auth.signin");
assert(t("auth.device.code", { code: "AB" }) === "code: AB", "interpolate en");
assert(tPageNav("general") === settingsEn["settings.page.general.nav"], "en page nav");
assert(
  tKnobLabel("ui-language") === settingsEn["settings.knob.ui-language"],
  "en language knob",
);

setLocale("ru");
assert(t("auth.signin") === "Войти", "ru auth.signin");
assert(t("toast.copied") === "Скопировано", "ru toast");
assert(tPageNav("general") === settingsRu["settings.page.general.nav"], "ru page nav");
assert(
  tKnobLabel("ui-language") === settingsRu["settings.knob.ui-language"],
  "ru language knob",
);
assert(
  tPageNav("general") !== settingsEn["settings.page.general.nav"],
  "ru page nav differs from en",
);

const missing = "auth.signin" as const;
const catalogsHole = { ...ru, "auth.signin": "" };
void catalogsHole;
setLocale("en");
assert(t(missing) === "Log in", "fallback still en when locale en");

applyLocale("ru");
assert(getLocale() === "ru", "applyLocale ru");
applyLocale("en");
assert(getLocale() === "en", "applyLocale en");

setLocale("en");
assert(clearchatText(undefined, undefined) === "Chat cleared", "clearchat room en");
assert(
  clearchatText("bob", 30, 3) === "bob timed out for 30s (3 times)",
  "clearchat timeout stack en",
);
assert(clearchatText("bob", undefined) === "bob was banned", "clearchat ban en");
assert(
  deletionNoticeText("bob", "hello world", 50) ===
    "A message from bob was deleted: hello world",
  "clearmsg en",
);
assert(whisperPrefix() === "Whisper: ", "whisper en");
assert(
  formatReplyHeader("bob", "hi there") === "Replying to @bob: hi there",
  "reply en",
);

setLocale("ru");
assert(clearchatText(undefined, undefined) === "чат очищен", "clearchat room ru");
assert(
  clearchatText("bob", 30, 3) === "bob тайм-аут 30с (3 раз)",
  "clearchat timeout stack ru",
);
assert(clearchatText("bob", undefined) === "bob забанен", "clearchat ban ru");
assert(whisperPrefix() === "Шёпот: ", "whisper ru");
assert(formatReplyHeader("bob", "") === "Ответ @bob", "reply empty ru");
setLocale("en");

setLocale("ru");
assert(
  formatInvokeError({
    code: "error.channel.none_active",
    message: "no active channel",
  }) === "нет активного канала",
  "formatInvokeError ru code",
);
assert(
  formatInvokeError({
    code: "error.channel.limit",
    message: "no more than 8 open channels",
    params: { max: "8" },
  }) === "не больше 8 открытых каналов",
  "formatInvokeError params",
);
assert(
  formatInvokeError({
    code: "internal",
    message: "lock",
  }) === "lock",
  "formatInvokeError fallback message",
);
assert(
  formatInvokeError({
    code: "error.filters.list_limit",
    message: "ignore logins: no more than 200 entries",
  }) === "ignore logins: no more than 200 entries",
  "formatInvokeError placeholder falls back to message",
);
assert(
  formatInvokeError({
    code: "error.filters.list_limit",
    message: "ignore logins: no more than 200 entries",
    params: { label: "ignore logins", max: "200" },
  }) === "ignore logins: не больше 200 записей",
  "formatInvokeError list_limit with params",
);
setLocale("en");

console.log("i18n tests ok");

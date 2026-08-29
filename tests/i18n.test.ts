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

console.log("i18n tests ok");

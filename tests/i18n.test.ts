import { en } from "../src/i18n/en.ts";
import { ru } from "../src/i18n/ru.ts";
import {
  applyLocale,
  getLocale,
  parseLocale,
  setLocale,
  t,
} from "../src/i18n/index.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(parseLocale("ru") === "ru", "parse ru");
assert(parseLocale("RU-ru") === "ru", "parse RU-ru");
assert(parseLocale("en") === "en", "parse en");
assert(parseLocale("") === "en", "parse empty → en");
assert(parseLocale(undefined) === "en", "parse undef → en");

const enKeys = Object.keys(en).sort();
const ruKeys = Object.keys(ru).sort();
assert(enKeys.length === ruKeys.length, `key count en=${enKeys.length} ru=${ruKeys.length}`);
for (let i = 0; i < enKeys.length; i += 1) {
  assert(enKeys[i] === ruKeys[i], `key mismatch at ${i}: ${enKeys[i]} vs ${ruKeys[i]}`);
}

setLocale("en");
assert(getLocale() === "en", "locale en");
assert(t("auth.signin") === "Log in", "en auth.signin");
assert(t("auth.device.code", { code: "AB" }) === "code: AB", "interpolate en");

setLocale("ru");
assert(t("auth.signin") === "Войти", "ru auth.signin");
assert(t("toast.copied") === "Скопировано", "ru toast");

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

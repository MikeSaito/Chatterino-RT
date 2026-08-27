import { applyUiLayout, parseUiLayout } from "../src/shell/uiLayout.ts";
import {
  CLASSIC_MIN_SIZE,
  EXTENDED_MIN_SIZE,
  minSizeForLayout,
} from "../src/shell/windowMinSize.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(parseUiLayout("Classic") === "Classic", "Classic");
assert(parseUiLayout("Extended") === "Extended", "Extended");
assert(parseUiLayout("classic") === "Extended", "case → Extended");
assert(parseUiLayout("") === "Extended", "empty → Extended");
assert(parseUiLayout(null) === "Extended", "null → Extended");
assert(parseUiLayout(1) === "Extended", "number → Extended");

assert(
  minSizeForLayout("Classic").width === CLASSIC_MIN_SIZE.width,
  "classic min w",
);
assert(
  minSizeForLayout("Classic").height === CLASSIC_MIN_SIZE.height,
  "classic min h",
);
assert(
  minSizeForLayout("Extended").width === EXTENDED_MIN_SIZE.width,
  "extended min w",
);
assert(
  minSizeForLayout("Extended").height === EXTENDED_MIN_SIZE.height,
  "extended min h",
);
assert(CLASSIC_MIN_SIZE.width < EXTENDED_MIN_SIZE.width, "classic narrower");

const app = { dataset: {} as DOMStringMap };
const settingsBtn = {
  dataset: {} as DOMStringMap,
  title: "Настройки",
  ariaLabel: "Настройки",
  getAttribute(name: string) {
    return name === "aria-label" ? this.ariaLabel : null;
  },
  setAttribute(name: string, value: string) {
    if (name === "aria-label") {
      this.ariaLabel = value;
    }
  },
};
const channelList = {
  role: "list",
  setAttribute(name: string, value: string) {
    if (name === "role") {
      this.role = value;
    }
  },
};

applyUiLayout(app as HTMLElement, "Classic", {
  settingsBtn: settingsBtn as unknown as HTMLButtonElement,
  channelList: channelList as HTMLUListElement,
});
assert(app.dataset.uiLayout === "classic", "dataset classic");
assert(settingsBtn.dataset.uiLayout === "classic", "settings dataset classic");
assert(settingsBtn.title === "Настройки", "settings title preserved");
assert(settingsBtn.ariaLabel === "Настройки", "settings aria preserved");
assert(channelList.role === "tablist", "classic tablist");

applyUiLayout(app as HTMLElement, "Extended", {
  settingsBtn: settingsBtn as unknown as HTMLButtonElement,
  channelList: channelList as HTMLUListElement,
});
assert(app.dataset.uiLayout === "extended", "dataset extended");
assert(settingsBtn.dataset.uiLayout === "extended", "settings dataset extended");
assert(channelList.role === "tablist", "extended tablist");

console.log("uiLayout.test.ts ok");

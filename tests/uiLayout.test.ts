import { applyUiLayout, parseUiLayout } from "../src/shell/uiLayout.ts";

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

const app = { dataset: {} as DOMStringMap };
const settingsBtn = { textContent: "Настройки", title: "" };
const channelList = {
  role: "list",
  setAttribute(name: string, value: string) {
    if (name === "role") {
      this.role = value;
    }
  },
};

applyUiLayout(app as HTMLElement, "Classic", {
  settingsBtn: settingsBtn as HTMLButtonElement,
  channelList: channelList as HTMLUListElement,
});
assert(app.dataset.uiLayout === "classic", "dataset classic");
assert(settingsBtn.textContent === "…", "classic settings label");
assert(channelList.role === "tablist", "classic tablist");

applyUiLayout(app as HTMLElement, "Extended", {
  settingsBtn: settingsBtn as HTMLButtonElement,
  channelList: channelList as HTMLUListElement,
});
assert(app.dataset.uiLayout === "extended", "dataset extended");
assert(settingsBtn.textContent === "Настройки", "extended settings label");
assert(channelList.role === "list", "extended list");

console.log("uiLayout.test.ts ok");

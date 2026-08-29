import {
  buildWebSearchUrl,
  isAllowedHttpUrl,
  presetToEngine,
  webSearchMenuLabel,
} from "../src/shell/webSearch.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(presetToEngine("DuckDuckGo")?.url.includes("duckduckgo") === true, "ddg");
assert(presetToEngine("Bing")?.name === "Bing", "bing");
assert(presetToEngine("Google")?.url.includes("google") === true, "google");
assert(presetToEngine("") === null, "empty preset");
assert(presetToEngine("Yahoo") === null, "unknown");

const url = buildWebSearchUrl(
  "https://duckduckgo.com/?q=",
  "hello world",
);
assert(
  url === "https://duckduckgo.com/?q=hello%20world",
  `encode got ${url}`,
);
assert(buildWebSearchUrl("", "x") === null, "empty engine");
assert(buildWebSearchUrl("https://duckduckgo.com/?q=", "  ") === null, "empty q");
assert(buildWebSearchUrl("not-a-url", "x") === null, "bad base");
assert(buildWebSearchUrl("javascript:alert(1)?q=", "x") === null, "js");
assert(buildWebSearchUrl("https://", "evil.com") === null, "host inject bare");
assert(buildWebSearchUrl("https://www.", "evil.com") === null, "host inject www");
assert(
  buildWebSearchUrl("https://user:pass@example.com/?q=", "x") === null,
  "userinfo base",
);
assert(isAllowedHttpUrl("https://example.com/a"), "https ok");
assert(!isAllowedHttpUrl("https://user:pass@example.com/"), "userinfo");
assert(webSearchMenuLabel("Google") === "Search with Google", "label named");
assert(webSearchMenuLabel("  ") === "Search", "label empty");
assert(
  webSearchMenuLabel("Google", true) === "Search with Google in private mode",
  "label private",
);

console.log("webSearch.test.ts: ok");

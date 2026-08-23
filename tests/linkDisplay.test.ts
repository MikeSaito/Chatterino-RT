import {
  lowercaseHostInLinkText,
  lowercaseLinkHosts,
} from "../src/chat/linkDisplay.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

assert(
  lowercaseHostInLinkText("https://Example.COM/Path?Q=1") ===
    "https://example.com/Path?Q=1",
  "https host",
);
assert(
  lowercaseHostInLinkText("HTTP://Example.COM/x") === "HTTP://example.com/x",
  "proto case kept",
);
assert(lowercaseHostInLinkText("https://example.com/a") === null, "already lower");
assert(
  lowercaseHostInLinkText("https://Ex.com:8443/a") === "https://ex.com:8443/a",
  "port",
);
assert(lowercaseHostInLinkText("Example.COM/foo") === "example.com/foo", "bare");
assert(lowercaseHostInLinkText("not a link") === null, "no host");
assert(lowercaseHostInLinkText("") === null, "empty");

const body = "see HTTPS://Foo.Bar/Baz and done";
const spans = [{ start: 4, end: 24 }]; // HTTPS://Foo.Bar/Baz
const out = lowercaseLinkHosts(body, spans);
assert(out === "see HTTPS://foo.bar/Baz and done", `got ${out}`);
assert(out.length === body.length, "utf16 len");

const noop = lowercaseLinkHosts("hi", [{ start: 0, end: 2 }]);
assert(noop === "hi", "non-link span");

console.log("linkDisplay.test.ts: ok");

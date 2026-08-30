import { formatPinnedBody } from "../src/shell/pinnedMessage.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

{
  const html = formatPinnedBody("<script>alert(1)</script> see https://ex.com/a");
  assert(!html.includes("<script>"), "xss tag stripped");
  assert(html.includes("&lt;script&gt;"), "xss escaped");
  assert(html.includes('href="https://ex.com/a"'), "https link");
}

{
  const html = formatPinnedBody("go https://a.com/?x=1&y=2 now");
  assert(html.includes('href="https://a.com/?x=1&amp;y=2"'), "amp in href");
  assert(!html.includes("&amp;amp;"), "no double escape");
}

{
  const html = formatPinnedBody("канал t.me/rish098 конец");
  assert(html.includes('href="https://t.me/rish098"'), "bare t.me href");
  assert(html.includes(">t.me/rish098<"), "bare t.me display");
}

console.log("pinnedMessage tests ok");

import {
  exportImageUploaderSettings,
  importImageUploaderSettings,
  parseShareXUrl,
  validateImportJson,
} from "../src/shell/imageUploaderSharex.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEq(parseShareXUrl(""), "", "empty");
assertEq(parseShareXUrl("{response}"), "", "response");
assertEq(parseShareXUrl("{RESPONSE}"), "", "response ci");
assertEq(parseShareXUrl("{json:files[0].url}"), "{files.0.url}", "jsonpath");
assertEq(
  parseShareXUrl("{json:response|files[0].url}"),
  "{files.0.url}",
  "piped",
);
assertEq(parseShareXUrl("{json:response|}"), "{}", "piped empty");
assertEq(parseShareXUrl("{data.link}"), "{data.link}", "passthrough");

{
  const validated = validateImportJson("");
  assert(!validated.ok, "empty clip");
}
{
  const validated = validateImportJson("{");
  assert(!validated.ok, "bad json");
}
{
  const validated = validateImportJson("[]");
  assert(!validated.ok, "array");
}
{
  const validated = validateImportJson(JSON.stringify({ RequestURL: "x" }));
  assert(!validated.ok, "no version");
}
{
  const validated = validateImportJson(JSON.stringify({ Version: "1" }));
  assert(!validated.ok, "no request url");
}

{
  const input = {
    Body: "MultipartFormData",
    DeletionURL: "https://imgur.com/delete/{data.deletehash}",
    FileFormName: "image",
    Headers: { Authorization: "Client-ID c898c0bb848ca39" },
    Name: "Chatterino Image Uploader Settings",
    RequestMethod: "POST",
    RequestURL: "https://api.imgur.com/3/image",
    URL: "{data.link}",
    Version: "1.0.0",
  };
  const got = importImageUploaderSettings(input);
  assert(got !== null, "imgur import");
  assertEq(got!.url, "https://api.imgur.com/3/image", "imgur url");
  assertEq(got!.formField, "image", "imgur field");
  assertEq(got!.link, "{data.link}", "imgur link");
  assertEq(
    got!.deletionLink,
    "https://imgur.com/delete/{data.deletehash}",
    "imgur del",
  );
  assertEq(got!.headers, "Authorization: Client-ID c898c0bb848ca39", "imgur hdr");
  assert(got!.enabled === true, "imgur enabled");
}

{
  const input = {
    Body: "MultipartFormData",
    DeletionURL: "{json:delete}",
    FileFormName: "file",
    Headers: { "X-bing": "bong", "X-foo": "bar" },
    RequestMethod: "POST",
    RequestURL: "https://kappa.lol/api/upload",
    URL: "{json:files[0].url}",
    Version: "14.0.1",
  };
  const got = importImageUploaderSettings(input);
  assert(got !== null, "jsonpath import");
  assertEq(got!.link, "{files.0.url}", "jsonpath link");
  assertEq(got!.deletionLink, "{delete}", "jsonpath del");
  assertEq(got!.headers, "X-bing: bong;X-foo: bar", "jsonpath hdr");
}

{
  const input = {
    Body: "MultipartFormData",
    DeletionURL: "{json:delete}",
    FileFormName: "file",
    Headers: { "X-bing": "bong", "X-foo": "bar" },
    RequestMethod: "POST",
    RequestURL: "https://kappa.lol/api/upload",
    URL: "{json:response|files[0].url}",
    Version: "14.0.1",
  };
  const got = importImageUploaderSettings(input);
  assert(got !== null, "piped import");
  assertEq(got!.link, "{files.0.url}", "piped link");
}

{
  const exported = exportImageUploaderSettings({
    url: "http://example.com",
    formField: "form",
    link: "foo{bar}baz",
    deletionLink: "{more}",
    headers: "My-Header: Foo",
  });
  assertEq(exported.Version, "1.0.0", "export ver");
  assertEq(exported.Name, "Chatterino Image Uploader Settings", "export name");
  assertEq(exported.RequestMethod, "POST", "export method");
  assertEq(exported.RequestURL, "http://example.com", "export url");
  assertEq(exported.Body, "MultipartFormData", "export body");
  assertEq(exported.FileFormName, "form", "export field");
  assertEq(exported.URL, "foo{bar}baz", "export link");
  assertEq(exported.DeletionURL, "{more}", "export del");
  assertEq(exported.Headers?.["My-Header"], "Foo", "export hdr");
}

{
  const round = exportImageUploaderSettings({
    url: "https://api.imgur.com/3/image",
    formField: "image",
    link: "{data.link}",
    deletionLink: "https://imgur.com/delete/{data.deletehash}",
    headers: "Authorization: Client-ID c898c0bb848ca39",
  });
  const text = JSON.stringify(round);
  const validated = validateImportJson(text);
  assert(validated.ok, "round validate");
  const got = importImageUploaderSettings(validated.value);
  assert(got !== null, "round import");
  assertEq(got!.url, "https://api.imgur.com/3/image", "round url");
  assertEq(got!.formField, "image", "round field");
  assertEq(got!.link, "{data.link}", "round link");
}

{
  const validated = validateImportJson(
    JSON.stringify({ Version: "1", RequestURL: 123 }),
  );
  assert(!validated.ok, "RequestURL type");
}

{
  const input = {
    Body: "MultipartFormData",
    DeletionURL: "{more}",
    FileFormName: "file",
    Headers: {
      "X-My-Header": "1",
      Another: "header",
      "My-Header": "Foo ; Bar : Baz ; KeyOnly",
    },
    Name: "Chatterino Image Uploader Settings",
    RequestMethod: "POST",
    RequestURL: "https://example.com",
    URL: "foo{bar}baz",
    Version: "1.0.0",
  };
  const got = importImageUploaderSettings(input);
  assert(got !== null, "headers import");
  assertEq(
    got!.headers,
    "Another: header;My-Header: Foo ; Bar : Baz ; KeyOnly;X-My-Header: 1",
    "headers sorted",
  );
}

assert(importImageUploaderSettings({ Version: "1", RequestURL: "x" }) === null, "missing fields");

console.log("imageUploaderSharex tests ok");

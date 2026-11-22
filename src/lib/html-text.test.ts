import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, stripTags } from "./html-text.ts";

describe("decodeEntities", () => {
  it("decodes the entities Magister emits", () => {
    assert.equal(
      decodeEntities(
        "A &amp; B&nbsp;C &lt;d&gt; &quot;e&quot; &#39;f&#39; &apos;g&apos;",
      ),
      "A & B C <d> \"e\" 'f' 'g'",
    );
  });
  it("unescapes once, so &amp;lt; stays &lt;", () => {
    assert.equal(decodeEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  });
  it("leaves unknown entities alone", () => {
    assert.equal(decodeEntities("50&euro; &copy;"), "50&euro; &copy;");
  });
});

describe("stripTags", () => {
  it("removes plain and nested markup", () => {
    assert.equal(stripTags("<p>Hoi <b>wereld</b></p>"), "Hoi wereld");
  });
  it("keeps stripping until no tag-shaped text is left", () => {
    const out = stripTags("<scr<script>ipt>alert(1)</scr</script>ipt>");
    assert.equal(out.includes("<"), false);
    assert.equal(out.includes(">"), false);
  });
  it("drops a tag that never closes so no angle brackets survive", () => {
    assert.equal(stripTags("2 < 3 en <script"), "2  3 en script");
  });
});

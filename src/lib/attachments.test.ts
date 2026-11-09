import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickDownloadHref, describeDownload } from "./attachments.ts";

describe("pickDownloadHref", () => {
  it("prefers the longer download link over the metadata Self link", () => {
    const links = [
      { Rel: "Self", Href: "/api/personen/1/afspraken/2/bijlagen/3" },
      {
        Rel: "Contents",
        Href: "/api/personen/1/afspraken/2/bijlagen/3/download",
      },
    ];
    assert.equal(
      pickDownloadHref(links),
      "/api/personen/1/afspraken/2/bijlagen/3/download",
    );
  });
  it("matches relations case-insensitively and ignores other relations", () => {
    const links = [
      {
        Rel: "Preview",
        Href: "/api/een/heel/lange/preview/link/die/niet/telt",
      },
      { Rel: "DOWNLOAD", Href: "/api/a/b/download" },
      { Rel: "self", Href: "/api/a/b" },
    ];
    assert.equal(pickDownloadHref(links), "/api/a/b/download");
  });
  it("understands the singular `content` relation used by sources (bronnen)", () => {
    const links = [
      { Rel: "Self", Href: "/api/personen/1/bronnen/5" },
      { Rel: "content", Href: "/api/personen/1/bronnen/5/content" },
    ];
    assert.equal(pickDownloadHref(links), "/api/personen/1/bronnen/5/content");
  });
  it("uses Self when it is the only link", () => {
    assert.equal(
      pickDownloadHref([{ Rel: "Self", Href: "/api/x/1" }]),
      "/api/x/1",
    );
  });
  it("keeps the first link on equal length", () => {
    const links = [
      { Rel: "Self", Href: "/api/aa" },
      { Rel: "Contents", Href: "/api/bb" },
    ];
    assert.equal(pickDownloadHref(links), "/api/aa");
  });
  it("falls back to Url, then to null", () => {
    assert.equal(
      pickDownloadHref(null, "https://example.test/f.pdf"),
      "https://example.test/f.pdf",
    );
    assert.equal(pickDownloadHref([], "/api/u"), "/api/u");
    assert.equal(pickDownloadHref([{ Rel: "Preview", Href: "/p" }], ""), null);
    assert.equal(pickDownloadHref(undefined), null);
  });
  it("skips links without an href", () => {
    assert.equal(pickDownloadHref([{ Rel: "Self", Href: "" }], null), null);
  });
});

describe("describeDownload", () => {
  it("says nothing when an app was opened or the browser downloaded it", () => {
    assert.equal(
      describeDownload({ location: "Download/Friday", opened: true }),
      null,
    );
    assert.equal(
      describeDownload({ location: "f.pdf", opened: false, inBrowser: true }),
      null,
    );
  });
  it("tells where a file was saved when nothing could open it", () => {
    assert.equal(
      describeDownload({
        location: "/home/joris/Downloads/f.pdf",
        opened: false,
      }),
      "Bestand opgeslagen in: /home/joris/Downloads/f.pdf",
    );
  });
  it("explains an offline answer", () => {
    assert.match(
      describeDownload({
        location: "Download/Friday",
        opened: false,
        earlier: true,
      }) ?? "",
      /offline.*Download\/Friday/,
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePickAnswer,
  getNativeFolderBridge,
  pickFolderViaBridge,
  folderLabelFromUri,
  type NativeFolderBridge,
} from "./folder-picker.ts";

const TREE = "content://com.android.externalstorage.documents/tree/primary%3ADownload%2FFriday";

describe("parsePickAnswer", () => {
  it("treats an empty answer as still waiting", () => {
    assert.deepEqual(parsePickAnswer(""), { kind: "waiting" });
    assert.deepEqual(parsePickAnswer(null), { kind: "waiting" });
    assert.deepEqual(parsePickAnswer(undefined), { kind: "waiting" });
  });
  it("understands cancel and error", () => {
    assert.deepEqual(parsePickAnswer("CANCELLED"), { kind: "cancelled" });
    assert.deepEqual(parsePickAnswer("ERROR:geen toegang"), { kind: "error", message: "geen toegang" });
    assert.deepEqual(parsePickAnswer("ERROR:"), { kind: "error", message: "onbekende fout" });
  });
  it("parses a picked folder", () => {
    const raw = JSON.stringify({ uri: TREE, name: "Download/Friday" });
    assert.deepEqual(parsePickAnswer(raw), {
      kind: "picked",
      folder: { uri: TREE, name: "Download/Friday" },
    });
  });
  it("derives the name when the app does not send one", () => {
    const answer = parsePickAnswer(JSON.stringify({ uri: TREE }));
    assert.equal(answer.kind === "picked" && answer.folder.name, "Download/Friday");
  });
  it("rejects garbage and non-content URIs", () => {
    assert.equal(parsePickAnswer("{nope").kind, "error");
    assert.equal(parsePickAnswer(JSON.stringify({ uri: "/home/x" })).kind, "error");
    assert.equal(parsePickAnswer(JSON.stringify({ name: "x" })).kind, "error");
  });
});

describe("getNativeFolderBridge", () => {
  it("is null without FridayNative or without the picker methods (old app)", () => {
    assert.equal(getNativeFolderBridge({}), null);
    assert.equal(
      getNativeFolderBridge({ FridayNative: { consumeNotificationTap: () => "" } }),
      null,
    );
  });
  it("returns the bridge when both methods exist", () => {
    const FridayNative = { pickFolder() {}, takePickedFolder: () => "" };
    assert.equal(getNativeFolderBridge({ FridayNative }), FridayNative);
  });
});

function fakeBridge(answers: string[]): NativeFolderBridge & { opened: number } {
  const queue = [...answers];
  return {
    opened: 0,
    pickFolder() {
      this.opened++;
    },
    takePickedFolder: () => queue.shift() ?? "",
  };
}

const noSleep = async () => {};

describe("pickFolderViaBridge", () => {
  it("opens the picker once and resolves with the folder after waiting", async () => {
    // first call clears a stale answer, then two "still open" polls, then the pick
    const bridge = fakeBridge(["", "", "", JSON.stringify({ uri: TREE, name: "Download/Friday" })]);
    const folder = await pickFolderViaBridge(bridge, { sleep: noSleep });
    assert.equal(bridge.opened, 1);
    assert.deepEqual(folder, { uri: TREE, name: "Download/Friday" });
  });
  it("ignores a stale answer left over from an earlier pick", async () => {
    const stale = JSON.stringify({ uri: "content://old/tree/x", name: "old" });
    const bridge = fakeBridge([stale, JSON.stringify({ uri: TREE, name: "new" })]);
    const folder = await pickFolderViaBridge(bridge, { sleep: noSleep });
    assert.equal(folder?.name, "new");
  });
  it("resolves null when the user cancels", async () => {
    const bridge = fakeBridge(["", "CANCELLED"]);
    assert.equal(await pickFolderViaBridge(bridge, { sleep: noSleep }), null);
  });
  it("rejects with the app's error message", async () => {
    const bridge = fakeBridge(["", "ERROR:geen toegang"]);
    await assert.rejects(pickFolderViaBridge(bridge, { sleep: noSleep }), /geen toegang/);
  });
  it("gives up when the picker never answers", async () => {
    const bridge = fakeBridge([]);
    await assert.rejects(
      pickFolderViaBridge(bridge, { sleep: noSleep, intervalMs: 100, timeoutMs: 1000 }),
      /geen antwoord/,
    );
  });
});

describe("folderLabelFromUri", () => {
  it("shows internal-storage folders without the volume", () => {
    assert.equal(folderLabelFromUri(TREE), "Download/Friday");
  });
  it("shows the volume for SD cards", () => {
    assert.equal(
      folderLabelFromUri("content://com.android.externalstorage.documents/tree/1A2B-3C4D%3ASchool"),
      "1A2B-3C4D: School",
    );
  });
  it("names the storage root", () => {
    assert.equal(
      folderLabelFromUri("content://com.android.externalstorage.documents/tree/primary%3A"),
      "Interne opslag",
    );
  });
  it("leaves desktop paths and odd URIs alone", () => {
    assert.equal(folderLabelFromUri("/home/joris/Downloads"), "/home/joris/Downloads");
    assert.equal(folderLabelFromUri("content://weird"), "content://weird");
  });
});

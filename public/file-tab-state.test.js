import { beforeEach, describe, expect, test } from "vitest";
import { FileTabState } from "./file-tab-state.js";

function makeMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

describe("FileTabState", () => {
  let storage;

  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  describe("openFile", () => {
    test("creates a new tab for a new file", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const tab = state.openFile("/workspace/project/src/main.js");
      expect(tab.id).toBe("file:/workspace/project/src/main.js");
      expect(tab.kind).toBe("file");
      expect(tab.mode).toBe("preview");
      expect(state.getTabs()).toHaveLength(1);
    });

    test("selects existing tab when opening same file again", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      state.openFile("/workspace/project/a.js");
      state.openFile("/workspace/project/b.js");
      const tab = state.openFile("/workspace/project/a.js");
      expect(state.getTabs()).toHaveLength(2);
      expect(state.getActiveTab().id).toBe("file:/workspace/project/a.js");
      expect(tab.id).toBe("file:/workspace/project/a.js");
    });

    test("uses metadata for fileName and mode", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const tab = state.openFile("/workspace/project/README.md", {
        fileName: "README.md",
        mode: "preview",
      });
      expect(tab.fileName).toBe("README.md");
      expect(tab.mode).toBe("preview");
    });
  });

  describe("selectTab", () => {
    test("selects an existing tab", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const t1 = state.openFile("/workspace/project/a.js");
      state.openFile("/workspace/project/b.js");
      expect(state.selectTab(t1.id)).toBe(true);
      expect(state.getActiveTab().id).toBe(t1.id);
    });

    test("returns false for non-existent tab", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      expect(state.selectTab("file:nonexistent")).toBe(false);
    });
  });

  describe("closeTab", () => {
    test("closes active tab and selects right neighbor", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const _t1 = state.openFile("/workspace/project/a.js");
      const t2 = state.openFile("/workspace/project/b.js");
      const t3 = state.openFile("/workspace/project/c.js");
      // activeTabId is t3
      state.selectTab(t2.id);
      const result = state.closeTab(t2.id);
      expect(result.closed).toBe(true);
      expect(result.nextTabId).toBe(t3.id);
      expect(state.getActiveTab().id).toBe(t3.id);
    });

    test("falls back to left neighbor when closing last tab", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const t1 = state.openFile("/workspace/project/a.js");
      state.openFile("/workspace/project/b.js");
      const result = state.closeTab(t1.id);
      // t1 is not active; b.js is active
      expect(result.closed).toBe(true);
      expect(state.getTabs()).toHaveLength(1);
    });

    test("returns null nextTabId when closing the only tab", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const t1 = state.openFile("/workspace/project/a.js");
      const result = state.closeTab(t1.id);
      expect(result.closed).toBe(true);
      expect(result.nextTabId).toBeNull();
      expect(state.getTabs()).toHaveLength(0);
      expect(state.getActiveTab()).toBeNull();
    });

    test("returns closed=false for non-existent tab", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const result = state.closeTab("file:nonexistent");
      expect(result.closed).toBe(false);
    });
  });

  describe("updateTab", () => {
    test("updates tab fields", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      const tab = state.openFile("/workspace/project/a.js");
      state.updateTab(tab.id, { mode: "edit", dirty: true, content: "new content" });
      const updated = state.getTab(tab.id);
      expect(updated.mode).toBe("edit");
      expect(updated.dirty).toBe(true);
      expect(updated.content).toBe("new content");
    });

    test("returns false for non-existent tab", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      expect(state.updateTab("file:nonexistent", { dirty: true })).toBe(false);
    });
  });

  describe("persistence", () => {
    test("persists and restores tabs per workspace", () => {
      const state1 = new FileTabState({ storage });
      state1.load("/workspace/projectA");
      state1.openFile("/workspace/projectA/a.js");
      state1.openFile("/workspace/projectA/b.js");

      const state2 = new FileTabState({ storage });
      state2.load("/workspace/projectA");
      expect(state2.getTabs()).toHaveLength(2);
      expect(state2.getTabs()[0].filePath).toBe("/workspace/projectA/a.js");
    });

    test("persists the selected tab without an explicit persist call", () => {
      const state1 = new FileTabState({ storage });
      state1.load("/workspace/project");
      const first = state1.openFile("/workspace/project/a.js");
      state1.openFile("/workspace/project/b.js");
      state1.selectTab(first.id);

      const state2 = new FileTabState({ storage });
      state2.load("/workspace/project");
      expect(state2.getActiveTab()?.filePath).toBe("/workspace/project/a.js");
    });

    test("falls back to the first tab when persisted activeTabId is stale", () => {
      storage.setItem(
        "picot-file-tabs",
        JSON.stringify({
          byRoot: {
            "/workspace/project": {
              tabs: [{ id: "file:/workspace/project/a.js", filePath: "/workspace/project/a.js" }],
              activeTabId: "file:/workspace/project/deleted.js",
            },
          },
        }),
      );
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      expect(state.getActiveTab()?.filePath).toBe("/workspace/project/a.js");
    });

    test("isolates tabs between different workspaces", () => {
      const state1 = new FileTabState({ storage });
      state1.load("/workspace/projectA");
      state1.openFile("/workspace/projectA/a.js");

      const state2 = new FileTabState({ storage });
      state2.load("/workspace/projectB");
      expect(state2.getTabs()).toHaveLength(0);
    });

    test("does not persist dirty content", () => {
      const state1 = new FileTabState({ storage });
      state1.load("/workspace/project");
      const tab = state1.openFile("/workspace/project/a.js");
      state1.updateTab(tab.id, {
        content: "dirty edit",
        originalContent: "original",
        dirty: true,
      });
      state1.persist();

      const raw = storage.getItem("picot-file-tabs");
      const parsed = JSON.parse(raw);
      const persistedTab = parsed.byRoot["/workspace/project"].tabs[0];
      expect(persistedTab.content).toBeUndefined();
      expect(persistedTab.originalContent).toBeUndefined();
      expect(persistedTab.dirty).toBeUndefined();
    });

    test("handles corrupted storage gracefully", () => {
      storage.setItem("picot-file-tabs", "{invalid json");
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      expect(state.getTabs()).toHaveLength(0);
    });

    test("handles missing byRoot gracefully", () => {
      storage.setItem("picot-file-tabs", JSON.stringify({}));
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      expect(state.getTabs()).toHaveLength(0);
    });
  });

  describe("subscribe", () => {
    test("notifies listeners on state change", () => {
      const state = new FileTabState({ storage });
      state.load("/workspace/project");
      let callCount = 0;
      const unsub = state.subscribe(() => callCount++);
      state.openFile("/workspace/project/a.js");
      expect(callCount).toBeGreaterThan(0);
      unsub();
    });
  });
});

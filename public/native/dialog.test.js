import { describe, expect, it } from "vitest";
import { parseDialogContent, parseOption, showNativeDialog } from "./dialog.js";

describe("native extension dialog", () => {
  it("parses rpiv ask-user-question select titles with previews", () => {
    const content = parseDialogContent({
      method: "select",
      title:
        "[Design] Which layout should we use?\n\n--- 1. Dense preview ---\nA | B\n---\n\n--- 2. Spacious preview ---\nA\n\nB",
    });

    expect(content).toEqual({
      header: "Design",
      title: "Which layout should we use?",
      body: "",
      previews: [
        { number: "1", label: "Dense", content: "A | B\n---" },
        { number: "2", label: "Spacious", content: "A\n\nB" },
      ],
    });
  });

  it("parses numbered options into label and description", () => {
    expect(parseOption("2. New feature — Build the requested capability")).toEqual({
      number: "2",
      label: "New feature",
      description: "Build the requested capability",
    });
  });

  it("renders multiline input prompts as readable body copy", () => {
    document.body.innerHTML = '<div id="dialog-container" class="hidden"></div>';
    const promise = showNativeDialog({
      method: "input",
      title:
        "[Testing] Which tests should run?\n\n1. Unit tests — Fast coverage\n2. Integration tests — Slower coverage\n\nEnter the numbers of all that apply.",
      placeholder: "1,2",
    });

    expect(document.querySelector(".dialog-header-badge")?.textContent).toBe("Testing");
    expect(document.querySelector(".dialog-title")?.textContent).toContain(
      "Which tests should run?",
    );
    expect(document.querySelector(".dialog-message")?.textContent).toContain("1. Unit tests");
    expect(document.querySelector(".dialog-input")?.getAttribute("placeholder")).toBe("1,2");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return expect(promise).resolves.toEqual({ cancelled: true });
  });
});

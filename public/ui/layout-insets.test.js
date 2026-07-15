import { describe, expect, test } from "vitest";
import { syncMessagesInsets } from "./layout-insets.js";

describe("syncMessagesInsets", () => {
  test("uses the live header and composer heights instead of hard-coded message padding", () => {
    const main = document.createElement("div");
    const messages = document.createElement("div");
    const header = document.createElement("div");
    const inputArea = document.createElement("div");

    syncMessagesInsets({
      main,
      messages,
      header,
      inputArea,
      measureHeight: (element) => {
        if (element === header) return 92;
        if (element === inputArea) return 118;
        return 0;
      },
    });

    expect(main.style.getPropertyValue("--messages-top-inset")).toBe("104px");
    expect(main.style.getPropertyValue("--messages-bottom-inset")).toBe("130px");
    expect(messages.style.getPropertyValue("scroll-padding-top")).toBe("104px");
    expect(messages.style.getPropertyValue("scroll-padding-bottom")).toBe("130px");
  });

  test("never shrinks below the base safe insets", () => {
    const main = document.createElement("div");
    const messages = document.createElement("div");
    const header = document.createElement("div");
    const inputArea = document.createElement("div");

    syncMessagesInsets({
      main,
      messages,
      header,
      inputArea,
      measureHeight: () => 20,
    });

    expect(main.style.getPropertyValue("--messages-top-inset")).toBe("68px");
    expect(main.style.getPropertyValue("--messages-bottom-inset")).toBe("100px");
  });
});

// ABOUTME: First Lit + TypeScript component in the native frontend. Renders
// ABOUTME: the header connection/run status pill (dot + text) declaratively
// ABOUTME: from `kind`/`label` properties, in light DOM, so existing
// ABOUTME: header.css class selectors keep working unchanged.

import { html, LitElement } from "lit";
import { classMap } from "lit/directives/class-map.js";

export type SessionStatusKind =
  | "connecting"
  | "working"
  | "connected"
  | "disconnected"
  | "loading"
  | "custom";

/**
 * `session-status.js` owns the state machine (mapping host status strings /
 * i18n to a kind + label) and sets `kind`/`label` on this element; this
 * component only owns declarative rendering of the indicator dot + text.
 */
export class SessionStatusPill extends LitElement {
  static properties = {
    kind: { type: String },
    label: { type: String },
  };

  declare kind: SessionStatusKind;
  declare label: string;

  constructor() {
    super();
    this.kind = "connecting";
    this.label = "Connecting...";
  }

  protected createRenderRoot(): this {
    return this;
  }

  protected render() {
    const working = this.kind === "working";
    const disconnected = this.kind === "disconnected";
    const indicatorClasses = classMap({
      "status-indicator": true,
      streaming: working,
      disconnected,
      connected: !working && !disconnected,
    });
    return html`
      <span class=${indicatorClasses} id="status-indicator"></span>
      <span class="status-text" id="status-text">${this.label}</span>
    `;
  }
}

customElements.define("picot-session-status", SessionStatusPill);

declare global {
  interface HTMLElementTagNameMap {
    "picot-session-status": SessionStatusPill;
  }
}

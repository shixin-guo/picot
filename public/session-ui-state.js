// ABOUTME: Coordinates host-backed per-session profiles and window-memory drafts.
// ABOUTME: Profiles never use browser storage; drafts disappear with this page instance.

const MAX_DRAFT_LENGTH = 20000;

function normalizeSessionKey(sessionFile) {
  return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile.trim() : "";
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const provider = typeof profile.provider === "string" ? profile.provider.trim() : "";
  const modelId = typeof profile.modelId === "string" ? profile.modelId.trim() : "";
  const thinkingLevel = typeof profile.thinkingLevel === "string" ? profile.thinkingLevel : "off";
  if (!provider || !modelId) return null;
  return { provider, modelId, thinkingLevel };
}

export class SessionUiStateStore {
  constructor({ profileClient = null } = {}) {
    this.profileClient = profileClient;
    this.drafts = new Map();
  }

  async loadProfile() {
    if (!this.profileClient?.load) return null;
    try {
      return normalizeProfile(await this.profileClient.load());
    } catch {
      return null;
    }
  }

  async saveProfile(profile) {
    const normalized = normalizeProfile(profile);
    if (!normalized || !this.profileClient?.save) return null;
    try {
      return normalizeProfile(await this.profileClient.save(normalized)) || normalized;
    } catch {
      return null;
    }
  }
  loadDraft(sessionFile) {
    const key = normalizeSessionKey(sessionFile);
    return key ? this.drafts.get(key) || "" : "";
  }

  saveDraft(sessionFile, draft) {
    const key = normalizeSessionKey(sessionFile);
    if (!key) return;
    const value = String(draft ?? "").slice(0, MAX_DRAFT_LENGTH);
    if (value) this.drafts.set(key, value);
    else this.drafts.delete(key);
  }

  clearDraft(sessionFile) {
    this.saveDraft(sessionFile, "");
  }
}

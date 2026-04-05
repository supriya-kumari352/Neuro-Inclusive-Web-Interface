import { create } from "zustand";
import type { PageSettings } from "../shared/messages.js";

import type { ProfileId } from "../shared/profiles.js";
import { profileToSettings } from "../shared/profiles.js";

const STORAGE_KEY = "neuro-inclusive-settings-v1";
const DEFAULT_API_BASE = "http://localhost:3000";

function normalizeApiBase(v: string): string {
  const trimmed = v.trim();
  if (!trimmed) return DEFAULT_API_BASE;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return DEFAULT_API_BASE;
    }
    return trimmed.replace(/\/+$/, "");
  } catch {
    return DEFAULT_API_BASE;
  }
}

export type AppState = {
  apiBase: string;
  profile: ProfileId;
  theme: PageSettings["theme"];
  fontSizePx: number;
  lineHeight: number;
  letterSpacingEm: number;
  readabilityMode: boolean;
  distractionReduction: boolean;
  focusMode: boolean;
  bionicReading: boolean;
  readingRuler: boolean;
  simplifiedView: "original" | "simplified";
  lastSimplified: string;
  lastOriginalSample: string;
  summaryText: string;
  cognitiveBefore: number | null;
  cognitiveAfter: number | null;
  cognitiveFactors: string;
  useServerCognitive: boolean;
  status: string;
  setApiBase: (v: string) => void;
  setProfile: (p: ProfileId) => void;
  patchPage: (p: Partial<PageSettings>) => void;
  setSimplifiedView: (v: "original" | "simplified") => void;
  setLastSimplified: (o: string, s: string) => void;
  setSummaryText: (s: string) => void;
  setCognitive: (before: number | null, after: number | null, factors?: string) => void;
  setUseServerCognitive: (v: boolean) => void;
  setStatus: (s: string) => void;
  hydrate: () => Promise<void>;
  persist: () => Promise<void>;
};

const defaultSettings: Pick<
  AppState,
  | "apiBase"
  | "profile"
  | "theme"
  | "fontSizePx"
  | "lineHeight"
  | "letterSpacingEm"
  | "readabilityMode"
  | "distractionReduction"
  | "focusMode"
  | "bionicReading"
  | "readingRuler"
  | "simplifiedView"
  | "lastSimplified"
  | "lastOriginalSample"
  | "summaryText"
  | "cognitiveBefore"
  | "cognitiveAfter"
  | "cognitiveFactors"
  | "useServerCognitive"
> = {
  apiBase: DEFAULT_API_BASE,
  profile: "none",
  theme: "default",
  fontSizePx: 16,
  lineHeight: 1.5,
  letterSpacingEm: 0,
  readabilityMode: false,
  distractionReduction: false,
  focusMode: false,
  bionicReading: false,
  readingRuler: false,
  simplifiedView: "simplified",
  lastSimplified: "",
  lastOriginalSample: "",
  summaryText: "",
  cognitiveBefore: null,
  cognitiveAfter: null,
  cognitiveFactors: "",
  useServerCognitive: false,
};

function toPageSettings(s: AppState): PageSettings {
  return {
    theme: s.theme,
    fontSizePx: s.fontSizePx,
    lineHeight: s.lineHeight,
    letterSpacingEm: s.letterSpacingEm,
    readabilityMode: s.readabilityMode,
    distractionReduction: s.distractionReduction,
    focusMode: s.focusMode,
    bionicReading: s.bionicReading,
    readingRuler: s.readingRuler,
  };
}

export const useStore = create<AppState>((set, get) => ({
  ...defaultSettings,
  status: "",
  setApiBase: (apiBase) => set({ apiBase: apiBase.trimStart() }),
  setProfile: (profile) => {
    const extra = profileToSettings(profile);
    set((state) => ({
      ...state,
      profile,
      ...extra,
    }));
  },
  patchPage: (p) => set(p as Partial<AppState>),
  setSimplifiedView: (simplifiedView) => set({ simplifiedView }),
  setLastSimplified: (lastOriginalSample, lastSimplified) =>
    set({ lastOriginalSample, lastSimplified }),
  setSummaryText: (summaryText) => set({ summaryText }),
  setCognitive: (cognitiveBefore, cognitiveAfter, cognitiveFactors = "") =>
    set({ cognitiveBefore, cognitiveAfter, cognitiveFactors }),
  setUseServerCognitive: (useServerCognitive) => set({ useServerCognitive }),
  setStatus: (status) => set({ status }),
  hydrate: async () => {
    const r = await chrome.storage.sync.get(STORAGE_KEY);
    const raw = r[STORAGE_KEY] as Partial<AppState> | undefined;
    if (raw && typeof raw === "object") {
      set({
        ...defaultSettings,
        ...raw,
        apiBase:
          typeof raw.apiBase === "string"
            ? normalizeApiBase(raw.apiBase)
            : DEFAULT_API_BASE,
      });
    }
  },
  persist: async () => {
    const {
      apiBase,
      profile,
      theme,
      fontSizePx,
      lineHeight,
      letterSpacingEm,
      readabilityMode,
      distractionReduction,
      focusMode,
      bionicReading,
      readingRuler,
      useServerCognitive,
    } = get();
    await chrome.storage.sync.set({
      [STORAGE_KEY]: {
        apiBase,
        profile,
        theme,
        fontSizePx,
        lineHeight,
        letterSpacingEm,
        readabilityMode,
        distractionReduction,
        focusMode,
        bionicReading,
        readingRuler,
        useServerCognitive,
      },
    });
  },
}));

export function getPageSettingsFromStore(): PageSettings {
  return toPageSettings(useStore.getState() as AppState);
}

// Gemini Live models the user can pick, read from the API so new models show up without an app update.

export interface LiveModel {
  id: string;
  name: string;
}

// Live models that only translate, transcribe or drive robots cannot hold a conversation with browser tools.
const SINGLE_PURPOSE = /translate|transcribe|robotics/i;

export const FALLBACK_MODELS: LiveModel[] = [
  { id: 'gemini-3.8-live', name: 'Gemini 3.8 Live' },
  { id: 'gemini-3.8-live-extended-thinking', name: 'Gemini 3.8 Live Extended Thinking' },
  { id: 'gemini-3.1-flash-live-preview', name: 'Gemini 3.1 Flash Live Preview' },
  { id: 'gemini-2.5-flash-native-audio-latest', name: 'Gemini 2.5 Flash Native Audio Latest' },
];

export const DEFAULT_MODEL = 'gemini-3.8-live';

/** Conversational Live models available to this API key, newest version first; a built-in list if the API is unreachable. */
export async function listLiveModels(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<LiveModel[]> {
  try {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) throw new Error(String(res.status));
    const { models = [] } = (await res.json()) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
    };
    const live = models
      .filter((m) => m.supportedGenerationMethods?.includes('bidiGenerateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
      .filter((m) => !SINGLE_PURPOSE.test(m.id));
    if (!live.length) return FALLBACK_MODELS;
    // Highest version number first (3.8 before 3.1 before 2.5), then by name.
    const version = (id: string) => parseFloat(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0');
    return live.sort((a, b) => version(b.id) - version(a.id) || a.name.localeCompare(b.name));
  } catch {
    return FALLBACK_MODELS;
  }
}

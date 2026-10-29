import { describe, expect, it } from 'vitest';
import { FALLBACK_MODELS, listLiveModels } from './models';
import { buildInstruction } from './prompt';
import { VOICES } from './voices';

// Shaped like the real /v1beta/models response for this project's key.
const live = (id: string, displayName: string) => ({ name: `models/${id}`, displayName, supportedGenerationMethods: ['bidiGenerateContent'] });
const apiResponse = {
  models: [
    { name: 'models/gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportedGenerationMethods: ['generateContent'] },
    live('gemini-3.5-transcribe-live', 'Gemini 3.5 Transcribe Live'),
    live('gemini-2.5-flash-native-audio-latest', 'Gemini 2.5 Flash Native Audio Latest'),
    live('gemini-3.1-flash-live-preview', 'Gemini 3.1 Flash Live Preview'),
    live('gemini-3.8-live', 'Gemini 3.8 Live'),
    live('gemini-3.8-live-extended-thinking', 'Gemini 3.8 Live Extended Thinking'),
    live('gemini-robotics-er-2-streaming-preview', 'Gemini Robotics-ER 2 Streaming Preview'),
    live('gemini-3.5-live-translate-preview', 'Gemini 3.5 Live Translate Preview'),
  ],
};
const fakeFetch = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 403, json: async () => body })) as unknown as typeof fetch;

describe('listLiveModels', () => {
  it('keeps conversational Live models, newest version first', async () => {
    const ids = (await listLiveModels('k', fakeFetch(apiResponse))).map((m) => m.id);
    expect(ids).toEqual([
      'gemini-3.8-live',
      'gemini-3.8-live-extended-thinking',
      'gemini-3.1-flash-live-preview',
      'gemini-2.5-flash-native-audio-latest',
    ]);
  });

  it('falls back to the built-in list when the API fails', async () => {
    expect(await listLiveModels('k', fakeFetch({}, false))).toBe(FALLBACK_MODELS);
    const throwing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await listLiveModels('k', throwing)).toBe(FALLBACK_MODELS);
  });
});

describe('buildInstruction', () => {
  it('puts safety rules before the personality and includes the name when set', () => {
    const text = buildInstruction('Farhan');
    expect(text.indexOf('Safety')).toBeLessThan(text.indexOf('Personality'));
    expect(text).toContain("The user's name is Farhan");
    expect(text).toContain('Never pay, order, check out, post, comment');
  });

  it('leaves the name line out when no name is set', () => {
    expect(buildInstruction('  ')).not.toContain("user's name is");
  });
});

it('has 30 distinct voices', () => {
  expect(new Set(VOICES.map((v) => v.name)).size).toBe(30);
});

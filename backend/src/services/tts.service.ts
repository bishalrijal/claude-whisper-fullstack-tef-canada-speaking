import OpenAI from 'openai';
import { getEnv } from '../lib/env.js';

const openai = new OpenAI({ apiKey: getEnv().openAiApiKey });

export type TtsLang = 'fr' | 'en';

// ── In-memory LRU cache ────────────────────────────────────────────────────────
// Scenario openings, closing lines, and short examiner phrases repeat frequently.
// Caching them avoids redundant API calls and makes those turns instant.
const CACHE_MAX = 120;
const cache = new Map<string, Buffer>();

function cacheGet(key: string): Buffer | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, audio: Buffer): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, audio);
}

/**
 * Converts text to speech using OpenAI tts-1.
 *
 * tts-1 is the stable, reliable model — consistent 1–2 s latency with no hangs.
 * Results are cached in an LRU store so repeated phrases (openings, closings,
 * short examiner replies) are served instantly without an API call.
 */
export async function textToSpeech(text: string, lang: TtsLang = 'fr'): Promise<Buffer> {
  const key = `${lang}:${text}`;

  const hit = cacheGet(key);
  if (hit) {
    console.log(`[tts] cache hit "${text.slice(0, 40)}"`);
    return hit;
  }

  const res = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'coral',
    input: text,
    response_format: 'opus',
    speed: lang === 'fr' ? 1.15 : 1.05,
  });

  const audio = Buffer.from(await res.arrayBuffer());
  cacheSet(key, audio);
  return audio;
}

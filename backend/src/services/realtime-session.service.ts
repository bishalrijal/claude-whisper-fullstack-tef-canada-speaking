import { createHash } from 'node:crypto';
import { SECTION_A_SCENARIOS, SECTION_B_SCENARIOS } from '../config/tef-prompts.js';
import { requireApiKey } from '../lib/env.js';
import { buildRealtimeInstructions } from './examiner.service.js';

export type ExamSection = 'A' | 'B';

/** Response shape from POST /v1/realtime/client_secrets (subset we use). */
export type RealtimeClientSecretResult = {
  value: string;
  expires_at: number;
};

const OPENAI_REALTIME_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

/** Whisper `prompt` length — keep under API limits; hint still helps vocabulary. */
const MAX_TRANSCRIPTION_PROMPT_CHARS = 1500;

/**
 * Mints a short-lived client secret so the browser can open a WebRTC Realtime session
 * without seeing the project's main API key.
 *
 * LEARN: Session `instructions` and transcription `prompt` are built server-side only
 * so hidden scenario fields (e.g. Section B resistance) never ship to the Angular bundle.
 */
export async function createExamRealtimeClientSecret(opts: {
  userId: string;
  section: ExamSection;
  scenarioId: string;
}): Promise<RealtimeClientSecretResult> {
  const apiKey = requireApiKey('openAiApiKey');
  const scenarios = opts.section === 'A' ? SECTION_A_SCENARIOS : SECTION_B_SCENARIOS;
  const scenario = scenarios.find(s => s.id === opts.scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenarioId: ${opts.scenarioId}`);
  }

  const instructions = buildRealtimeInstructions(scenario, opts.section, scenario.opening);
  const transcriptionPrompt = scenario.whisperHint.slice(0, MAX_TRANSCRIPTION_PROMPT_CHARS);

  // LEARN: Privacy-preserving stable id — OpenAI ties abuse signals to this, not raw email.
  const safetyId = createHash('sha256').update(`tef-user:${opts.userId}`).digest('hex').slice(0, 48);

  const body = {
    expires_after: {
      anchor: 'created_at' as const,
      // Session max 60m — allow headroom for clock skew (API allows up to 7200s).
      seconds: 7200,
    },
    session: {
      type: 'realtime' as const,
      model: 'gpt-realtime-2',
      instructions,
      // Match examiner brevity (1–3 sentences); avoids runaway audio cost.
      max_output_tokens: 220,
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: 24000,
          },
          noise_reduction: { type: 'near_field' as const },
          // Async transcription for UI + grading logs; not identical to what the audio model "heard".
          transcription: {
            model: 'whisper-1',
            language: 'fr',
            prompt: transcriptionPrompt,
          },
          turn_detection: {
            type: 'semantic_vad' as const,
            // 'low' requires a stronger, more confident speech signal before
            // triggering — ignores short noise bursts, clicks, background sounds.
            // Trade-off: the model waits slightly longer before responding.
            eagerness: 'low' as const,
          },
        },
        output: {
          voice: 'marin',
        },
      },
    },
  };

  const res = await fetch(OPENAI_REALTIME_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': safetyId,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[realtime] client_secrets failed', res.status, errText);
    throw new Error(`OpenAI Realtime client_secrets failed (${res.status})`);
  }

  const data = (await res.json()) as { value?: string; expires_at?: number };
  if (!data.value || typeof data.expires_at !== 'number') {
    console.error('[realtime] unexpected client_secrets response', data);
    throw new Error('OpenAI Realtime client_secrets returned an unexpected body');
  }

  return { value: data.value, expires_at: data.expires_at };
}

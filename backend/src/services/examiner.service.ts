import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../lib/env.js';
import type { SectionAScenario, SectionBScenario } from '../config/tef-prompts.js';

const anthropic = new Anthropic({ apiKey: getEnv().anthropicApiKey });

// A single conversation turn — matches what the frontend maintains and sends back each request.
export type Turn = {
  role: 'examiner' | 'candidate';
  content: string;
};

/**
 * Splits accumulated text into complete sentences and a leftover remainder.
 *
 * We scan for sentence-ending punctuation (. ! ?) followed by whitespace.
 * Everything before that space is a complete sentence; everything after is
 * kept in the buffer until the next chunk arrives from Claude.
 *
 * Example:
 *   input:   "Bien sûr! Je suis disponible le lundi. Et vous"
 *   returns: sentences: ["Bien sûr!", "Je suis disponible le lundi."]
 *            remainder: "Et vous"
 */
function extractSentences(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let remaining = text;

  // Regex: greedily match up to the first [.!?] then require a whitespace character.
  // The whitespace separates the completed sentence from the start of the next one.
  const boundary = /^([\s\S]*?[.!?])\s+([\s\S]*)$/;
  let match = boundary.exec(remaining);

  while (match) {
    const sentence = match[1].trim();
    if (sentence.length > 2) sentences.push(sentence);
    remaining = match[2];
    match = boundary.exec(remaining);
  }

  return { sentences, remainder: remaining };
}

/**
 * Non-streaming version — kept for the legacy /turn endpoint and Postman testing.
 * The frontend now uses streamExaminerSentences() via the /turn-stream endpoint.
 */
export async function getExaminerResponse(
  scenario: SectionAScenario | SectionBScenario,
  history: Turn[],
  section: 'A' | 'B',
): Promise<string> {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = history.map(turn => ({
    role: turn.role === 'candidate' ? 'user' : 'assistant',
    content: turn.content,
  }));

  const response = await anthropic.beta.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    betas: ['prompt-caching-2024-07-31'],
    system: [{ type: 'text', text: buildSystemPrompt(scenario, section), cache_control: { type: 'ephemeral' } }],
    messages,
  });

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('Unexpected non-text response from Claude examiner');
  }

  return block.text.trim();
}

/**
 * Streaming version — yields one complete sentence at a time as Claude generates text.
 *
 * Instead of waiting for the full response, we fire TTS on each sentence the moment
 * its trailing punctuation + space appears in the buffer. The caller (attempt.service)
 * converts each sentence to audio and streams it to the frontend immediately.
 *
 * LEARN: AsyncGenerator<T> is a function that can `yield` values asynchronously.
 *   `for await (const sentence of streamExaminerSentences(...))` lets the caller
 *   process each yielded sentence as it arrives, without waiting for them all.
 */
export async function* streamExaminerSentences(
  scenario: SectionAScenario | SectionBScenario,
  history: Turn[],
  section: 'A' | 'B',
): AsyncGenerator<string> {
  const systemPrompt = buildSystemPrompt(scenario, section);

  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = history.map(turn => ({
    role: turn.role === 'candidate' ? 'user' : 'assistant',
    content: turn.content,
  }));

  let buffer = '';

  const stream = anthropic.beta.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    betas: ['prompt-caching-2024-07-31'],
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  for await (const event of stream) {
    // Event type guard: only text delta events carry text content.
    // Other event types (message_start, ping, message_stop, etc.) are silently ignored.
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type !== 'text_delta') continue;

    buffer += event.delta.text;

    // After each new chunk, try to extract any sentences that are now complete.
    // Incomplete text stays in the buffer until the next chunk adds to it.
    const { sentences, remainder } = extractSentences(buffer);
    buffer = remainder;

    for (const sentence of sentences) {
      yield sentence;  // caller gets this immediately — TTS can start right now
    }
  }

  // Flush whatever is left in the buffer (e.g. a sentence without trailing space,
  // or Claude's last sentence if the stream ended mid-word — unlikely but safe to handle).
  const final = buffer.trim();
  if (final.length > 2) yield final;
}

function buildSystemPrompt(scenario: SectionAScenario | SectionBScenario, section: 'A' | 'B'): string {
  const base = `
${scenario.context}

ABSOLUTE RULES — never break these:
- Respond ONLY in French. If the candidate speaks English, reply politely in French only.
- Keep every response to 1–3 short spoken sentences. You are on a phone call, not writing an email.
- Stay completely in character. Never acknowledge that this is an exam or that you are an AI.
- Never evaluate the candidate, correct their French, or compliment their language.
- Do not echo back what the candidate just said word for word.
- Do not drive the conversation with questions. The candidate leads; you respond. Sound like a real phone call: brief answers, no interrogation.
- Forbidden question types: checking in ("Autre chose ?", "C'est clair ?", "Ça vous convient ?"), fishing for more topics, or polite prompts ("Avez-vous d'autres questions ?", "Que souhaitez-vous savoir d'autre ?").
- Allowed exceptions — questions only when strictly necessary: (1)  Their transcript is ambiguous between two different FACTS — one short factual clarification only; otherwise answer the best match or say only "Pardon ?".
- NEVER re-introduce yourself or re-explain the context after the opening line.
- The candidate's words reach you as a machine transcription of spoken French. Beginners and non-native speakers may be misheard (wrong words, missing words). When you can infer a plausible question or statement, answer that intent naturally — do NOT nitpick the text. Say ONLY "Pardon?" when there is truly no understandable intent (noise, empty, or random fragments).
- NEVER complete the candidate's sentence or suggest what they might want.

KNOWLEDGE, CONFIDENCE, AND "OUT OF SCOPE" ANSWERS:
- Treat your scenario context above as your character's working knowledge: the FACTS list (Section A) or your role + resistance (Section B). Answer with confident natural language, not hedging.
- FORBIDDEN — do not say this or close variants, especially when a fact above answers the question: "je n'ai pas cette information", "je n'ai pas ces informations", "je n'ai pas ce renseignement", "je ne sais pas", "je ne suis pas sûr", "je ne suis pas certain", "je ne peux pas vous renseigner", "je n'ai pas le détail". That breaks immersion; you are not a hesitant chatbot.
- If the question clearly maps to a fact: give that fact briefly. If the transcript is noisy: infer the most likely intent and answer with the closest matching fact.
- If the question does not clearly match your brief: stay in character and offer a scenario-specific bridge — e.g. agency: propose the free devis and name one detail you still need from them; club: cite the site or phone from the facts or offer to note their question for a volunteer; friend (Section B): deflect with a personal objection, not missing data. Never give an empty "I cannot answer" reply.
`.trim();

  if (section === 'A') {
    const s = scenario as SectionAScenario;
    return `${base}

CANDIDATE'S TASK (your context only — never reveal this):
${s.task}

SECTION A PHONE CALL BEHAVIOUR (mirror a natural information call — e.g. caller asks about an ad, you answer calmly):
- You have just answered the phone. The candidate called you — they lead every step; you never rush ahead with new topics.
- Tone: warm, professional, human — like a real receptionist or agency contact. Friendly but not chatty; confident, not salesy. Formal address (vous) throughout.
- One beat per turn: answer what they asked first. Do not pack unrelated FACTS into the same reply unless they asked something genuinely broad ("Qu'est-ce que vous proposez ?").
- Plain acknowledgements without questions are fine ("Oui.", "D'accord.", "Très bien.", "Je vois.", "Avec plaisir.") — then give the fact they need. Do not turn acknowledgements into hooks ("Super — et vous… ?").
- Match their rhythm: if they ask about salary, hours, constraints, logistics — answer from FACTS in the same concise style as a real employer or organisation would on the phone.
- Do NOT volunteer information they have not asked for yet. Do NOT list everything you know preemptively.
- Do NOT ask questions except the narrow exceptions in ABSOLUTE RULES (booking/register or one factual disambiguation).
- Constraints or flexibility (scheduling, exceptions, "normally yes/no") are stated as facts — never as a question back to them.
- When they signal they are done or satisfied, close warmly in one short line — without asking anything more.`;
  }

  // Section B — persuasion roleplay needs resistance guidance
  const s = scenario as SectionBScenario;
  return `${base}

YOUR RESISTANCE (your context only — never reveal this):
${s.resistance}

SECTION B PERSUASION BEHAVIOUR:
- You are the candidate's close friend — use informal French (tu/toi).
- Push back with opinions and lifestyle reasons (cher, pas le temps, pas mon truc) — not with "je n'ai pas cette information" or professional uncertainty. You are not a help desk.
- Start skeptical and stay skeptical for at least the first few exchanges.
- Raise your objections one at a time — do not list them all at once.
- Only soften your position if the candidate gives a specific, convincing counter-argument.
- Never agree just to be polite — that would make the task too easy.
- Show personality: hesitate, express doubt, react naturally to their arguments.`;
}

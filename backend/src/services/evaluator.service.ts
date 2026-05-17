import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../lib/env.js';
import type { Turn } from './examiner.service.js';
import type { DeliverySnapshot } from './delivery-metrics.js';
import { formatDeliveryLogForEvaluator } from './delivery-metrics.js';
import { evaluationResultSchema, type EvaluationResult } from '../schemas/evaluation.schemas.js';

const anthropic = new Anthropic({ apiKey: getEnv().anthropicApiKey });

export type { EvaluationResult };

/**
 * Strips markdown fences and isolates the first `{` … `}` block — models often add chatter.
 */
function extractJsonObject(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Evaluator model output contained no JSON object');
  }
  return trimmed.slice(start, end + 1);
}

/**
 * Static evaluation rubric — identical for every exam session.
 * Extracted as a module-level constant so it can be cached by the API across calls.
 */
const EVALUATOR_SYSTEM = `
Tu es un examinateur certifié du TEF Canada (Test d'Évaluation de Français).
Évalue UNIQUEMENT la performance orale du CANDIDAT (pas de l'examinatrice) dans la transcription fournie.

DISFLUENCES ET TRANSCRIPTION ORALE :
- La transcription provient d'un système automatique : hésitations ("euh"), allongements ("ahhh"), faux départs et réformulations peuvent apparaître comme plusieurs morceaux ou ponctuation étrange.
- Pour grammar et lexicalRichness : évalue surtout le propos final ou l'intention globale ; ne pénalise pas deux fois une même erreur annulée par une réformulation immédiate.
- Pour coherence : utilise les DONNÉES OBJECTIVES DE FLUIDITÉ ci-dessus (longues pauses, nombre de segments, débit) pour calibrer les hésitations et la fragmentation. Une seule micro-coupure ne doit pas faire chuter le score comme un discours illisible.

NIVEAU CEFR À ATTRIBUER :
Choisis UN seul niveau parmi : A1, A2, B1, B2, C1, C2.
Base ta décision sur la performance orale globale du candidat :
- A1 : quelques mots isolés, ne peut pas accomplir une tâche téléphonique de façon autonome
- A2 : peut gérer des échanges simples et prévisibles avec effort, vocabulaire très limité, erreurs fréquentes
- B1 : gère les situations courantes, communique l'essentiel malgré des erreurs, registre limité
- B2 : à l'aise dans des situations inconnues, bon vocabulaire, erreurs mineures qui ne gênent pas
- C1 : fluide, précis, gère les complications naturellement, vocabulaire riche
- C2 : quasi-natif, aucune erreur significative, expression spontanée et nuancée

CALIBRATION IMPORTANTE :
Sois un évaluateur rigoureux, pas indulgent. Un candidat TEF Canada moyen (niveau B1) obtient environ 2.5–3.0 par critère.
Réserve 4.0–5.0 uniquement pour une performance clairement supérieure à la moyenne.
Si tu hésites entre deux scores, choisis le plus bas.

CRITÈRES D'ÉVALUATION (chaque critère noté de 0.0 à 5.0) :

- lexicalRichness : variété, précision et richesse du vocabulaire utilisé.
  5.0 = vocabulaire varié et précis adapté au contexte
  3.0 = vocabulaire suffisant mais limité ou répétitif
  1.0 = vocabulaire très pauvre, beaucoup de répétitions ou d'approximations

- taskFulfillment : est-ce que le candidat a accompli la tâche principale de façon claire et complète ?
  5.0 = tâche entièrement accomplie avec tous les détails nécessaires
  3.0 = tâche partiellement accomplie, quelques informations manquantes
  1.0 = tâche non accomplie ou très incomplète

- grammar : correction grammaticale (conjugaisons, accords, structures de phrases).
  5.0 = très peu d'erreurs, structures variées et correctes
  3.0 = erreurs présentes mais la communication reste claire
  1.0 = nombreuses erreurs qui gênent la compréhension

- coherence : fluidité, organisation logique, enchaînement naturel des idées, et gestion de la conversation.
  Sois STRICT sur ce critère. La plupart des apprenants intermédiaires se situent entre 2.0 et 3.0.

  5.0 = discours parfaitement fluide et structuré ; transitions naturelles ; aucune hésitation significative ; les idées s'enchaînent logiquement du début à la fin
  4.0 = quelques hésitations mineures mais le fil conducteur est clair ; connecteurs logiques bien utilisés (donc, alors, parce que, en fait...)
  3.0 = hésitations fréquentes ou pauses longues ; quelques ruptures dans la logique ; les idées sont compréhensibles mais pas bien reliées entre elles
  2.0 = réponses courtes et isolées sans lien entre elles ; répétitions du même mot ou de la même phrase ; difficulté à maintenir le fil de la conversation
  1.0 = discours très décousu ; idées aléatoires sans progression ; l'interlocuteur doit faire beaucoup d'efforts pour suivre

  PÉNALISE SPÉCIFIQUEMENT :
  - Les réponses d'une seule phrase sans aucun connecteur logique (−0.5 à −1.0)
  - Les répétitions de la même expression plus d'une fois (−0.5)
  - Les changements de sujet brusques ou non justifiés (−0.5)
  - L'incapacité à enchaîner naturellement après une réponse de l'examinatrice (−0.5)
  - Les hésitations longues ("euh... euh...") avant chaque réponse (−0.5)

Réponds UNIQUEMENT avec un objet JSON valide sur une ou plusieurs lignes (aucun texte avant ou après, pas de markdown).
Utilise de vraies valeurs : pour cefrLevel une seule chaîne parmi A1, A2, B1, B2, C1, C2 (sans chevrons ni alternatives).
Pour sectionAScore et sectionBScore utilise un nombre décimal OU la valeur null JSON (sans guillemets) si la section n'a pas été passée.

Exemple de forme (avec des scores fictifs — adapte à la performance réelle) :
{
  "cefrLevel": "B1",
  "overallScore": 2.8,
  "sectionAScore": 2.8,
  "sectionBScore": null,
  "lexicalRichness": 2.5,
  "taskFulfillment": 3.0,
  "grammar": 2.5,
  "coherence": 3.0,
  "feedback": "...",
  "suggestions": "..."
}
`.trim();

/** Parses and validates evaluator JSON — throws with context on failure (caught → 500). */
function parseEvaluatorResponse(modelText: string): EvaluationResult {
  const jsonStr = extractJsonObject(modelText);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Evaluator JSON.parse error:', msg, 'snippet:', jsonStr.slice(0, 400));
    throw new Error(`Evaluator JSON was not valid: ${msg}`);
  }
  const parsed = evaluationResultSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Evaluator Zod issues:', parsed.error.flatten());
    throw new Error('Evaluator JSON did not match the expected rubric shape');
  }
  return parsed.data;
}

/**
 * Evaluates the full conversation after the exam ends.
 * Claude steps out of character and acts as a TEF Canada examiner scoring the candidate.
 *
 * We ask Claude to return structured JSON so we can parse it reliably into the DB schema.
 */
export async function evaluateConversation(
  history: Turn[],
  sections: ('A' | 'B')[],
  reason: 'timeout' | 'user_terminated',
  candidateDelivery: DeliverySnapshot[] = [],
): Promise<EvaluationResult> {

  const transcript = history
    .map(t => `${t.role === 'examiner' ? 'Examinatrice' : 'Candidat'}: ${t.content}`)
    .join('\n');

  const deliveryBlock = formatDeliveryLogForEvaluator(history, candidateDelivery);
  const sectionsLabel = sections.join(' et ');

  // Dynamic per-exam content — section, optional reason note, delivery metrics, transcript.
  const userContent = [
    `Section(s) évaluée(s) : Section ${sectionsLabel}.`,
    reason === 'user_terminated'
      ? "Note : le candidat a mis fin à l'examen avant la fin du temps imparti — tiens-en compte dans taskFulfillment."
      : '',
    '',
    deliveryBlock,
    '',
    'TRANSCRIPTION :',
    transcript,
  ].filter(line => line !== undefined).join('\n').trim();

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    // EVALUATOR_SYSTEM is a large static constant — cached after the first call.
    system: [{ type: 'text', text: EVALUATOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new Error('Unexpected non-text response from Claude evaluator');
  }

  return parseEvaluatorResponse(block.text);
}

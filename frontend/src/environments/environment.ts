// Development environment — used when running `ng serve` locally.
// angular.json replaces this file with environment.prod.ts for production builds.

/** Flashcards “Listen” only — speaking exam still uses the microphone. */
export type FlashcardTtsMode = 'api' | 'browser';

export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000',
  wsPath: '/socket.io',
  /**
   * Owner-only (you edit this before `ng serve` / deploy — learners cannot change it):
   * - `api` → POST /tts (OpenAI on your backend)
   * - `browser` → `speechSynthesis` (free; install FR/EN voices in the OS if missing)
   */
  flashcardTtsMode: 'api' satisfies FlashcardTtsMode,
};

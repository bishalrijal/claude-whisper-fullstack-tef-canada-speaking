// Production — swapped in by `angular.json` fileReplacements.

import type { EnvironmentConfig, FlashcardTtsMode } from './environment.types';

export type { FlashcardTtsMode };

export const environment: EnvironmentConfig = {
  production: true,
  /** Reverse proxy forwards `/api` to the Node listener (`PORT` / host from deployment env). */
  apiUrl: '/api',
  /** nginx strips /api/ prefix, so /api/socket.io → backend /socket.io */
  wsPath: '/api/socket.io',
  /** Owner-only — set to `browser` to skip OpenAI on flashcards (install FR voices on clients). */
  flashcardTtsMode: 'api',
};

import type { Turn } from '../services/examiner.service.js';

// ── Client → Server ────────────────────────────────────────────────────────

export type StartExamPayload = {
  section: 'A' | 'B';
  scenarioId: string;
};

export type TranscriptUpdatePayload = {
  role: 'candidate' | 'examiner';
  content: string;
};

export type EndExamPayload = {
  reason: 'timeout' | 'user_terminated';
};

// ── Server → Client ────────────────────────────────────────────────────────

export type TokenRefreshedEvent = {
  clientSecret: string;
  expiresAt: number;
};

export type ExamStartedEvent = {
  attemptId: string;
  scenarioId: string;
  scenarioImageUrl: string;
  openingText: string;
  openingAudio: string; // base64 opus
  /** Short-lived secret for browser WebRTC to `wss://api.openai.com` /realtime/calls. */
  realtime: { clientSecret: string; expiresAt: number };
};

export type EvaluationResult = {
  overallScore: number;
  sectionAScore: number | null;
  sectionBScore: number | null;
  lexicalRichness: number;
  taskFulfillment: number;
  grammar: number;
  coherence: number;
  cefrLevel: string;
  feedback: string;
  suggestions: string;
};

export type ExamEndedEvent = {
  closingText: string;
  closingAudio: string; // base64 opus
  evaluation: EvaluationResult;
};

export type WsErrorEvent = {
  message: string;
};

// ── Socket.io typed map interfaces ─────────────────────────────────────────

export type ServerToClientEvents = {
  exam_started: (data: ExamStartedEvent) => void;
  token_refreshed: (data: TokenRefreshedEvent) => void;
  exam_ended: (data: ExamEndedEvent) => void;
  error: (data: WsErrorEvent) => void;
};

export type ClientToServerEvents = {
  start_exam: (payload: StartExamPayload) => void;
  transcript_update: (payload: TranscriptUpdatePayload) => void;
  token_refresh: () => void;
  end_exam: (payload: EndExamPayload) => void;
};

export type SocketData = {
  userId: string;
};

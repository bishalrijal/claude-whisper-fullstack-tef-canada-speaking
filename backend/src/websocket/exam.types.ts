import type { DeliverySnapshot } from '../services/delivery-metrics.js';
import type { Turn } from '../services/examiner.service.js';

// ── Client → Server ────────────────────────────────────────────────────────

export type StartExamPayload = {
  section: 'A' | 'B';
  scenarioId: string;
};

export type EndExamPayload = {
  reason: 'timeout' | 'user_terminated';
  /** Browser-authoritative transcript for GPT Realtime exams (server VAD + WebRTC). */
  history?: Turn[];
};

// audio_submit is sent as a raw binary ArrayBuffer/Buffer — no wrapper type needed

// ── Server → Client ────────────────────────────────────────────────────────

export type ExamStartedEvent = {
  attemptId: string;
  scenarioId: string;
  scenarioImageUrl: string;
  openingText: string;
  openingAudio: string; // base64 opus
  /** Short-lived secret for browser WebRTC to `wss://api.openai.com` /realtime/calls. */
  realtime: { clientSecret: string; expiresAt: number };
};

export type TranscriptEvent = {
  text: string;
  delivery: DeliverySnapshot;
};

export type ExaminerSentenceEvent = {
  sentenceText: string;
  audio: string; // base64 opus
};

export type TurnDoneEvent = {
  skipped: boolean;
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
  transcript: (data: TranscriptEvent) => void;
  examiner_sentence: (data: ExaminerSentenceEvent) => void;
  turn_done: (data: TurnDoneEvent) => void;
  exam_ended: (data: ExamEndedEvent) => void;
  error: (data: WsErrorEvent) => void;
};

export type ClientToServerEvents = {
  start_exam: (payload: StartExamPayload) => void;
  audio_submit: (audioBuffer: Buffer) => void;
  end_exam: (payload: EndExamPayload) => void;
};

export type SocketData = {
  userId: string;
};

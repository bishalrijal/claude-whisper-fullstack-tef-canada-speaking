import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';

// ── Event shapes mirrored from backend exam.types.ts ──────────────────────

export type DeliverySnapshot = {
  durationSec: number;
  segmentCount: number;
  speechDurationSec: number;
  longestPauseSec: number;
  wordsEstimate: number;
  wordsPerMinute: number | null;
};

export type Turn = { role: 'examiner' | 'candidate'; content: string };

export type ExamStartedEvent = {
  attemptId: string;
  scenarioId: string;
  scenarioImageUrl: string;
  openingText: string;
  openingAudio: string; // base64 opus
  /** Short-lived `ek_…` for browser WebRTC to OpenAI Realtime */
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

// ── Service ────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ExamSocketService {
  private socket: Socket | null = null;

  readonly examStarted$ = new Subject<ExamStartedEvent>();
  readonly transcript$ = new Subject<TranscriptEvent>();
  readonly examinerSentence$ = new Subject<ExaminerSentenceEvent>();
  readonly turnDone$ = new Subject<TurnDoneEvent>();
  readonly examEnded$ = new Subject<ExamEndedEvent>();
  readonly wsError$ = new Subject<{ message: string }>();

  connect(apiUrl: string, wsPath: string): void {
    if (this.socket?.connected) return;

    // In dev:  apiUrl = 'http://localhost:3000' (absolute) → use directly as WS server
    // In prod: apiUrl = '/api' (relative)        → connect to current page origin instead
    const wsOrigin = apiUrl.startsWith('http') ? apiUrl : window.location.origin;

    this.socket = io(`${wsOrigin}/exam`, {
      path: wsPath,
      withCredentials: true,
      transports: ['websocket'],
    });

    this.socket.on('exam_started', (d: ExamStartedEvent) => this.examStarted$.next(d));
    this.socket.on('transcript', (d: TranscriptEvent) => this.transcript$.next(d));
    this.socket.on('examiner_sentence', (d: ExaminerSentenceEvent) => this.examinerSentence$.next(d));
    this.socket.on('turn_done', (d: TurnDoneEvent) => this.turnDone$.next(d));
    this.socket.on('exam_ended', (d: ExamEndedEvent) => this.examEnded$.next(d));
    this.socket.on('error', (d: { message: string }) => this.wsError$.next(d));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  startExam(section: 'A' | 'B', scenarioId: string): void {
    this.socket?.emit('start_exam', { section, scenarioId });
  }

  submitAudio(blob: Blob): void {
    blob.arrayBuffer().then(buf => this.socket?.emit('audio_submit', buf));
  }

  endExam(reason: 'timeout' | 'user_terminated', history?: Turn[]): void {
    this.socket?.emit('end_exam', { reason, ...(history?.length ? { history } : {}) });
  }
}

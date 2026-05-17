import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';

// ── Event shapes mirrored from backend exam.types.ts ──────────────────────

export type ExamStartedEvent = {
  attemptId: string;
  scenarioId: string;
  scenarioImageUrl: string;
  openingText: string;
  openingAudio: string; // base64 opus
  /** Short-lived `ek_…` for browser WebRTC to OpenAI Realtime */
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

export type TokenRefreshedEvent = {
  clientSecret: string;
  expiresAt: number;
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
  readonly tokenRefreshed$ = new Subject<TokenRefreshedEvent>();
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
    this.socket.on('token_refreshed', (d: TokenRefreshedEvent) => this.tokenRefreshed$.next(d));
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

  transcriptUpdate(role: 'candidate' | 'examiner', content: string): void {
    this.socket?.emit('transcript_update', { role, content });
  }

  requestTokenRefresh(): void {
    this.socket?.emit('token_refresh');
  }

  endExam(reason: 'timeout' | 'user_terminated'): void {
    this.socket?.emit('end_exam', { reason });
  }
}

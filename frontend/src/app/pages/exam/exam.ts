import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { Store } from '@ngrx/store';
import { Router } from '@angular/router';
import { AttemptService } from '../../services/attempt';
import { ExamSocketService } from '../../services/exam-socket.service';
import { ExamRealtimeService } from '../../services/exam-realtime.service';
import { environment } from '../../../environments/environment';
import { AppShellHeaderComponent } from '../../shared/components/app-shell-header/app-shell-header.component';
import { shellActions } from '../../shared/state/shell/shell.actions';

type ExamState = 'idle' | 'listening' | 'processing' | 'ai-speaking' | 'evaluating' | 'done';
type Turn = { role: 'examiner' | 'candidate'; content: string };

const EXAM_DURATION_SECONDS = 5 * 60;


/** Build absolute URL for scenario images — handles `/assets/…` from API and avoids double slashes. */
function resolveScenarioAssetUrl(pathOrUrl: string): string {
  const raw = pathOrUrl.trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = environment.apiUrl.replace(/\/+$/, '');
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `${base}${path}`;
}

@Component({
  selector: 'app-exam',
  imports: [AppShellHeaderComponent],
  templateUrl: './exam.html',
  styleUrl: './exam.scss',
})
export class Exam implements OnInit, OnDestroy {
  private router = inject(Router);
  private store = inject(Store);
  private attemptService = inject(AttemptService);
  private examSocket = inject(ExamSocketService);
  private examRealtime = inject(ExamRealtimeService);

  // Exam metadata
  section = signal<'A' | 'B'>('A');
  attemptId = signal('');
  scenarioId = signal('');
  scenarioImageUrl = signal('');
  scenarioImageBroken = signal(false);

  // UI state
  state = signal<ExamState>('idle');
  timeLeft = signal(EXAM_DURATION_SECONDS);
  error = signal('');
  showTranscript = signal(false);

  // Display-only conversation history (server holds the authoritative copy)
  history: Turn[] = [];

  // Internal timer ref
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  // Guards against race conditions when endExam() fires during an in-flight turn
  private examEnded = false;

  // WebSocket event subscriptions — cleaned up in ngOnDestroy
  private wsSubscription = new Subscription();

  private playbackContext: AudioContext | null = null;

  ngOnInit() {
    const nav = window.history.state as { section?: 'A' | 'B' };
    if (!nav?.section) {
      this.router.navigate(['/exam/select']);
      return;
    }
    this.section.set(nav.section);
    this.store.dispatch(
      shellActions.brandTaglineSet({ tagline: `Exam · Section ${nav.section}` }),
    );

    // Connect WebSocket early so the handshake completes before the user presses Start
    this.examSocket.connect(environment.apiUrl, environment.wsPath);
    this.registerSocketEvents();

    this.loadScenarioPreview(nav.section);
  }

  private registerSocketEvents(): void {
    this.wsSubscription.add(
      this.examSocket.examStarted$.subscribe(async (data) => {
        this.attemptId.set(data.attemptId);
        this.scenarioId.set(data.scenarioId);
        this.scenarioImageBroken.set(false);
        this.scenarioImageUrl.set(resolveScenarioAssetUrl(data.scenarioImageUrl));
        this.history.push({ role: 'examiner', content: data.openingText });

        await this.playBase64Audio(data.openingAudio);
        this.startTimer();

        try {
          await this.examRealtime.connect(data.realtime.clientSecret, data.realtime.expiresAt, {
            onCandidateTranscript: (text) => {
              // Always forward to server — in-flight Whisper results can arrive a
              // moment after examEnded is set; dropping them would lose the last turn.
              this.examSocket.transcriptUpdate('candidate', text);
              if (this.examEnded) return;
              this.history.push({ role: 'candidate', content: text });
              this.state.set('listening');
            },
            onExaminerAudioStart: () => {
              if (this.examEnded) return;
              // First audio chunk just arrived — mute mic NOW before echo builds up.
              // setMicMuted stops all audio reaching OpenAI, so the VAD has nothing
              // to trigger on regardless — no session.update needed.
              this.examRealtime.setMicMuted(true);
              this.examRealtime.clearInputBuffer();
              this.state.set('ai-speaking');
            },
            onExaminerTranscript: (text) => {
              this.examSocket.transcriptUpdate('examiner', text);
              if (this.examEnded) return;
              this.history.push({ role: 'examiner', content: text });
            },
            onResponseDone: () => {
              if (this.examEnded) return;
              // Full response finished — unmute mic so candidate can respond.
              this.examRealtime.setMicMuted(false);
              this.state.set('listening');
            },
            onError: (message) => {
              this.error.set(message);
            },
            onNearExpiry: () => {
              this.examSocket.requestTokenRefresh();
            },
          });
          if (!this.examEnded) this.state.set('listening');
        } catch {
          this.error.set('Could not start voice session');
        }
      }),
    );

    this.wsSubscription.add(
      this.examSocket.tokenRefreshed$.subscribe((data) => {
        this.examRealtime.updateClientSecret(data.clientSecret, data.expiresAt);
      }),
    );

    this.wsSubscription.add(
      this.examSocket.examEnded$.subscribe(async (data) => {
        if (data.closingAudio) {
          await this.playBase64Audio(data.closingAudio);
        }
        this.state.set('done');
        this.router.navigate(['/dashboard']);
      }),
    );

    this.wsSubscription.add(
      this.examSocket.wsError$.subscribe((e) => {
        this.error.set(e.message ?? 'Connection error');
      }),
    );
  }

  private async loadScenarioPreview(section: 'A' | 'B') {
    try {
      const preview = await this.attemptService.getScenarioPreview(section);
      this.scenarioId.set(preview.scenarioId);
      this.scenarioImageBroken.set(false);
      this.scenarioImageUrl.set(resolveScenarioAssetUrl(preview.scenarioImageUrl));
    } catch {
      // Non-fatal — the image just won't show until the exam starts
    }
  }

  onScenarioImgError(): void {
    this.scenarioImageBroken.set(true);
  }

  ngOnDestroy() {
    this.wsSubscription.unsubscribe();
    this.examRealtime.disconnect();
    this.examSocket.disconnect();
    this.cleanup();
  }

  // ─── Step 1: User presses Play ───────────────────────────────────────────

  async beginExam() {
    this.error.set('');
    this.state.set('processing');
    this.playbackContext = new AudioContext();
    this.examSocket.startExam(this.section(), this.scenarioId());
    // Exam continues in the examStarted$ subscription handler
  }

  // ─── Step 2: End exam (timer or user button) ─────────────────────────────

  endExam(reason: 'timeout' | 'user_terminated') {
    this.examEnded = true;
    this.examRealtime.disconnect();
    this.stopTimer();
    this.state.set('evaluating');
    this.examSocket.endExam(reason);
    // Navigate happens in the examEnded$ subscription handler
  }

  // ─── Audio helpers ────────────────────────────────────────────────────────

  private decodeAudio(base64: string): Promise<AudioBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return this.playbackContext!.decodeAudioData(bytes.buffer.slice(0));
  }

  private playAudioBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const source = this.playbackContext!.createBufferSource();
      source.buffer = buffer;
      source.connect(this.playbackContext!.destination);
      source.onended = () => resolve();
      source.start();
    });
  }

  private playBase64Audio(base64: string): Promise<void> {
    return this.decodeAudio(base64).then(buf => this.playAudioBuffer(buf));
  }

  private startTimer() {
    this.timerInterval = setInterval(() => {
      const next = this.timeLeft() - 1;
      this.timeLeft.set(next);
      if (next <= 0) {
        this.endExam('timeout');
      }
    }, 1000);
  }

  private stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private cleanup() {
    this.stopTimer();
    this.playbackContext?.close();
    this.playbackContext = null;
  }

  get formattedTime(): string {
    const m = Math.floor(this.timeLeft() / 60).toString().padStart(2, '0');
    const s = (this.timeLeft() % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  get stateLabel(): string {
    switch (this.state()) {
      case 'idle': return 'Press play to begin';
      case 'listening': return 'Listening...';
      case 'processing': return 'Processing...';
      case 'ai-speaking': return 'Examiner speaking...';
      case 'evaluating': return 'Evaluating...';
      case 'done': return 'Done!';
    }
  }
}

import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { Store } from '@ngrx/store';
import { Router } from '@angular/router';
import { AttemptService } from '../../services/attempt';
import { ExamSocketService } from '../../services/exam-socket.service';
import { ExamRealtimeService } from '../../services/exam-realtime.service';
import type { DeliverySnapshot } from '../../services/exam-socket.service';
import { environment } from '../../../environments/environment';
import { AppShellHeaderComponent } from '../../shared/components/app-shell-header/app-shell-header.component';
import { shellActions } from '../../shared/state/shell/shell.actions';

type ExamState = 'idle' | 'listening' | 'processing' | 'ai-speaking' | 'evaluating' | 'done';
type Turn = { role: 'examiner' | 'candidate'; content: string };

const EXAM_DURATION_SECONDS = 5 * 60;
const SILENCE_THRESHOLD = 12;
const SILENCE_DURATION_MS = 1200;
const MIN_SPEECH_FRAMES = 4;

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

  private candidateDeliveryLog: DeliverySnapshot[] = [];

  // Accumulates examiner sentence texts within a single turn for the display history push
  private examinerAccumText = '';

  // Internal audio/timer refs
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private analyser: AnalyserNode | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private audioChunks: Blob[] = [];

  // Guards against race conditions when endExam() fires during an in-flight turn
  private examEnded = false;

  // WebSocket event subscriptions — cleaned up in ngOnDestroy
  private wsSubscription = new Subscription();

  // ── Audio queue ────────────────────────────────────────────────────────────
  private playbackContext: AudioContext | null = null;
  private audioQueue: Array<Promise<AudioBuffer>> = [];
  private isDraining = false;
  private drainResolve: (() => void) | null = null;

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
        this.candidateDeliveryLog = [];
        this.history.push({ role: 'examiner', content: data.openingText });

        await this.playBase64Audio(data.openingAudio);
        this.startTimer();

        try {
          await this.examRealtime.connect(data.realtime.clientSecret, {
            onCandidateTranscript: (text) => {
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
              if (this.examEnded) return;
              // Audio is done by the time this fires — just update the transcript display.
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
          });
          if (!this.examEnded) this.state.set('listening');
        } catch {
          this.error.set('Could not start voice session');
        }
      }),
    );

    this.wsSubscription.add(
      this.examSocket.transcript$.subscribe((data) => {
        this.history.push({ role: 'candidate', content: data.text });
        if (data.delivery && typeof data.delivery.durationSec === 'number') {
          this.candidateDeliveryLog.push(data.delivery);
        }
      }),
    );

    this.wsSubscription.add(
      this.examSocket.examinerSentence$.subscribe((data) => {
        this.state.set('ai-speaking');
        this.examinerAccumText += (this.examinerAccumText ? ' ' : '') + data.sentenceText;
        this.queueAudio(data.audio);
      }),
    );

    this.wsSubscription.add(
      this.examSocket.turnDone$.subscribe(async (data) => {
        if (data.skipped) {
          if (!this.examEnded) await this.startListening();
          return;
        }
        if (this.examinerAccumText) {
          this.history.push({ role: 'examiner', content: this.examinerAccumText });
          this.examinerAccumText = '';
        }
        await this.waitForAudioDone();
        if (!this.examEnded) await this.startListening();
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

  // ─── Step 2: Listen for candidate speech ─────────────────────────────────

  private async startListening() {
    this.state.set('listening');
    this.audioChunks = [];

    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    this.mediaRecorder = new MediaRecorder(this.mediaStream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.mediaRecorder.start(100);

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    let speechFrameCount = 0;
    let speechConfirmed = false;

    this.silenceCheckInterval = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      if (avg > SILENCE_THRESHOLD) {
        speechFrameCount++;
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
        if (speechFrameCount >= MIN_SPEECH_FRAMES) {
          speechConfirmed = true;
        }
      } else {
        speechFrameCount = 0;
        if (speechConfirmed && !this.silenceTimer) {
          this.silenceTimer = setTimeout(() => {
            this.submitTurn();
          }, SILENCE_DURATION_MS);
        }
      }
    }, 100);
  }

  // ─── Step 3: Submit audio over WebSocket ─────────────────────────────────

  private submitTurn() {
    this.stopListening();
    this.state.set('processing');
    this.examinerAccumText = '';

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
    this.examSocket.submitAudio(audioBlob);
    // Processing continues in the transcript$, examinerSentence$, turnDone$ subscriptions
  }

  // ─── Step 4: End exam (timer or user button) ─────────────────────────────

  endExam(reason: 'timeout' | 'user_terminated') {
    this.examEnded = true;
    this.examRealtime.disconnect();
    this.stopListening();
    this.stopTimer();
    this.state.set('evaluating');
    this.examSocket.endExam(reason, this.history);
    // Navigate happens in the examEnded$ subscription handler
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

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

  private queueAudio(base64: string): void {
    this.audioQueue.push(this.decodeAudio(base64));
    if (!this.isDraining) {
      this.isDraining = true;
      void this.drainAudioQueue();
    }
  }

  private async drainAudioQueue(): Promise<void> {
    while (this.audioQueue.length > 0) {
      if (this.examEnded) break;
      const buffer = await this.audioQueue.shift()!;
      await this.playAudioBuffer(buffer);
    }
    this.audioQueue = [];
    this.isDraining = false;
    if (this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
  }

  private waitForAudioDone(): Promise<void> {
    if (!this.isDraining && this.audioQueue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.drainResolve = resolve;
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

  private stopListening() {
    if (this.silenceCheckInterval) clearInterval(this.silenceCheckInterval);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceCheckInterval = null;
    this.silenceTimer = null;
    this.mediaRecorder?.stop();
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.audioContext?.close();
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.analyser = null;
  }

  private cleanup() {
    this.stopListening();
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

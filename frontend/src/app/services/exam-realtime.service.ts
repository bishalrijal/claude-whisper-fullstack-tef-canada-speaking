import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const MAX_RECONNECT_ATTEMPTS = 3;

/** Content block inside a response output item. */
type RealtimeContentBlock = {
  type?: string;       // 'audio' | 'text'
  transcript?: string; // set when type === 'audio'
  text?: string;       // set when type === 'text'
};

/** Output item inside a response.done payload. */
type RealtimeOutputItem = {
  type?: string;   // 'message' | 'function_call'
  role?: string;   // 'assistant'
  content?: RealtimeContentBlock[];
};

/** Token usage reported in response.done. */
type RealtimeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

/** Subset of fields we read from OpenAI Realtime server events. */
type RealtimeServerEvent = {
  type?: string;
  transcript?: string; // conversation.item.input_audio_transcription.completed / output_audio_transcript.done
  delta?: string;      // response.audio.delta — base64-encoded PCM16 audio chunk
  error?: { message?: string; code?: string };
  // Populated on response.done — contains the full output + usage stats.
  response?: {
    id?: string;
    status?: string;
    output?: RealtimeOutputItem[];
    usage?: RealtimeUsage;
  };
};

export type ExamRealtimeHandlers = {
  onCandidateTranscript: (text: string) => void;
  onExaminerTranscript: (text: string) => void;
  // Fires the moment the first audio chunk from the examiner arrives —
  // earlier than onExaminerTranscript, which fires after audio is done.
  // Use this to mute the mic at the right time.
  onExaminerAudioStart: () => void;
  onResponseDone: () => void;
  onError: (message: string) => void;
  // Fires ~5 minutes before the client secret expires so the caller can
  // request a fresh one from the backend before any reconnect would need it.
  onNearExpiry: () => void;
};

/**
 * Pulls the audio transcript out of a response.done output array.
 * Concatenates all audio content blocks in order (typically just one).
 */
function extractOutputTranscript(output: RealtimeOutputItem[] | undefined): string {
  if (!output) return '';
  const parts: string[] = [];
  for (const item of output) {
    for (const block of item.content ?? []) {
      if (block.type === 'audio' && block.transcript) {
        parts.push(block.transcript.trim());
      }
    }
  }
  return parts.join(' ');
}

/**
 * Browser WebRTC session to OpenAI Realtime (`gpt-realtime-2`).
 *
 * LEARN: Mic audio goes out via `addTrack`; examiner audio returns on `ontrack`.
 * Text for transcripts (UI + grading) arrives on the `oai-events` data channel as JSON lines.
 *
 * Reconnection: if ICE enters the `failed` state the service closes the dead
 * RTCPeerConnection and opens a fresh one (up to MAX_RECONNECT_ATTEMPTS times)
 * reusing the same mic stream and audio element so the user experience is seamless.
 */
@Injectable({ providedIn: 'root' })
export class ExamRealtimeService {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private remoteAudioEl: HTMLAudioElement | null = null;

  // Kept alive across reconnects — stopping a track is permanent.
  private micStream: MediaStream | null = null;

  // Stored so openConnection() can retry without re-accepting parameters.
  private clientSecret: string | null = null;
  private expiresAt = 0; // Unix timestamp in seconds
  private activeHandlers: ExamRealtimeHandlers | null = null;
  private reconnectAttempts = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Delayed mic-unmute scheduled after audio playback duration elapses.
  private pendingUnmute: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param clientSecret from the backend (`ek_…`) — never the project's main API key.
   * @param expiresAt    Unix timestamp (seconds) when the client secret expires.
   */
  async connect(clientSecret: string, expiresAt: number, handlers: ExamRealtimeHandlers): Promise<void> {
    this.disconnect();

    this.clientSecret = clientSecret;
    this.expiresAt = expiresAt;
    this.activeHandlers = handlers;
    this.reconnectAttempts = 0;
    this.scheduleRefresh();

    // Mic and audio element are created once here and reused across reconnects.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // LEARN: These are standard browser DSP constraints applied BEFORE
        // audio is sent anywhere — the browser processes the raw mic signal first.
        echoCancellation: true,   // removes speaker output picked up by the mic
        noiseSuppression: true,   // filters steady-state noise (fan, AC hum, keyboard)
        autoGainControl: true,    // normalises volume so quiet speakers aren't missed
        sampleRate: 24000,        // match OpenAI Realtime's expected sample rate
      },
    });

    this.remoteAudioEl = document.createElement('audio');
    this.remoteAudioEl.autoplay = true;
    // Must be in the DOM — detached audio elements can have playback silenced
    // or cut short by browser autoplay policy mid-sentence.
    this.remoteAudioEl.style.display = 'none';
    document.body.appendChild(this.remoteAudioEl);

    await this.openConnection();
  }

  /**
   * Creates and negotiates a new RTCPeerConnection using the stored client secret.
   * Called once from connect() and again on each ICE failure (up to MAX_RECONNECT_ATTEMPTS).
   * Mic stream and audio element are NOT touched here — they outlive individual connections.
   */
  private async openConnection(): Promise<void> {
    const clientSecret = this.clientSecret!;
    const handlers = this.activeHandlers!;

    const pc = new RTCPeerConnection();
    this.pc = pc;

    pc.ontrack = (e: RTCTrackEvent) => {
      if (this.remoteAudioEl) this.remoteAudioEl.srcObject = e.streams[0];
    };

    // LEARN: oniceconnectionstatechange fires as ICE negotiation progresses.
    // `failed` means ICE has definitively given up — unlike `disconnected`, which
    // is transient and may self-recover. We only act on `failed`.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        void this.handleIceFailure();
      }
    };

    // Reuse the same MediaStreamTrack across reconnects. Closing a PeerConnection
    // does not stop its tracks — they have independent lifecycles — so the same
    // track (and its current enabled/muted state) carries over to the new PC.
    const [track] = this.micStream!.getTracks();
    pc.addTrack(track, this.micStream!);

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;

    // Per-response state tracked via closure — reset on each new response.
    let audioStartedThisResponse = false;
    let audioBytesThisResponse = 0;  // accumulated PCM bytes for duration estimate
    let responseHadAudio = false;    // true if any response.audio.delta fired

    dc.addEventListener('message', (e: MessageEvent<string>) => {
      let ev: RealtimeServerEvent;
      try {
        ev = JSON.parse(e.data) as RealtimeServerEvent;
      } catch {
        return;
      }
      const t = ev.type;

      if (!environment.production) {
        // Suppress high-frequency delta events from the full log to keep the console readable.
        if (t !== 'response.audio.delta') {
          console.debug('[realtime]', t, ev);
        }
      }

      if (t === 'response.audio.delta') {
        // Accumulate audio bytes so we can estimate playback duration.
        // delta is base64-encoded PCM16 at 24 kHz — 4 base64 chars ≈ 3 raw bytes.
        if (ev.delta) audioBytesThisResponse += Math.floor(ev.delta.length * 0.75);

        if (!audioStartedThisResponse) {
          audioStartedThisResponse = true;
          responseHadAudio = true;
          handlers.onExaminerAudioStart();
        }
      }

      if (t === 'response.audio.done') {
        // All audio chunks have been pushed to the WebRTC track. Calculate how long
        // the browser still needs to play them: PCM16 at 24 kHz = 48 000 bytes/s.
        const playbackMs = Math.ceil(audioBytesThisResponse / 48);
        // Add a buffer for the WebRTC playout queue and VAD stabilisation after silence.
        const PLAYOUT_BUFFER_MS = 300;

        if (this.pendingUnmute) clearTimeout(this.pendingUnmute);
        this.pendingUnmute = setTimeout(() => {
          this.pendingUnmute = null;
          handlers.onResponseDone();
        }, playbackMs + PLAYOUT_BUFFER_MS);
      }

      if (t === 'response.done') {
        audioStartedThisResponse = false;

        if (!environment.production) {
          const usage = ev.response?.usage;
          const transcript = extractOutputTranscript(ev.response?.output);
          console.debug('[realtime] response.done — status:', ev.response?.status,
            '| usage:', usage, '| output transcript:', transcript || '(empty)');
        }

        // Text-only responses produce no audio.delta/audio.done events — fire
        // onResponseDone immediately so the mic doesn't stay muted indefinitely.
        if (!responseHadAudio) {
          handlers.onResponseDone();
        }

        responseHadAudio = false;
        audioBytesThisResponse = 0;
      }

      // Examiner transcript — fires when the output audio transcription is ready.
      // Using response.output_audio_transcript.done (not response.done) because
      // gpt-realtime-2 may not populate output[].content[].transcript in response.done.
      if (t === 'response.output_audio_transcript.done' && typeof ev.transcript === 'string') {
        const trimmed = ev.transcript.trim();
        if (trimmed) handlers.onExaminerTranscript(trimmed);
      }

      // Candidate transcript — async Whisper transcription of the user's audio input.
      // Requires `transcription: { model: 'whisper-1' }` in the session config.
      if (t === 'conversation.item.input_audio_transcription.completed' && typeof ev.transcript === 'string') {
        const trimmed = ev.transcript.trim();
        if (trimmed) handlers.onCandidateTranscript(trimmed);
      }

      if (t === 'error') {
        const msg = ev.error?.message ?? 'Realtime session error';
        handlers.onError(msg);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
      method: 'POST',
      body: offer.sdp ?? '',
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
    });

    if (!sdpResponse.ok) {
      const detail = await sdpResponse.text().catch(() => '');
      handlers.onError(`Realtime handshake failed (${sdpResponse.status}) ${detail.slice(0, 200)}`);
      this.disconnect();
      return;
    }

    const answerSdp = await sdpResponse.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /**
   * Schedules handlers.onNearExpiry() to fire 5 minutes before expiresAt.
   * Uses Math.max(0, …) so sessions that are already within that window fire immediately.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const msUntilRefresh = this.expiresAt * 1000 - Date.now() - 5 * 60 * 1000;
    this.refreshTimer = setTimeout(() => {
      this.activeHandlers?.onNearExpiry();
    }, Math.max(0, msUntilRefresh));
  }

  /**
   * Replaces the stored client secret after a successful backend refresh.
   * Call this in response to the `token_refreshed` WebSocket event.
   * Does NOT renegotiate the active WebRTC session — the existing connection
   * continues uninterrupted; the new secret is only needed if a reconnect occurs.
   */
  updateClientSecret(secret: string, expiresAt: number): void {
    this.clientSecret = secret;
    this.expiresAt = expiresAt;
    this.scheduleRefresh();
  }

  /**
   * Triggered when ICE enters the `failed` state.
   * Closes the dead PeerConnection and re-opens a fresh one without touching
   * the mic stream or audio element. Gives up after MAX_RECONNECT_ATTEMPTS.
   */
  private async handleIceFailure(): Promise<void> {
    const handlers = this.activeHandlers;
    if (!handlers) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      handlers.onError('Voice connection lost — could not reconnect');
      return;
    }

    // Reconnect requires a fresh SDP handshake — bail early if the secret has expired
    // so the user gets a clear message instead of a silent 401 from OpenAI.
    if (Date.now() >= this.expiresAt * 1000) {
      handlers.onError('Voice session expired — please start a new exam');
      return;
    }

    this.reconnectAttempts++;

    // Cancel any pending unmute from the dying connection.
    if (this.pendingUnmute) { clearTimeout(this.pendingUnmute); this.pendingUnmute = null; }

    // Close only the peer connection — do NOT stop mic tracks.
    this.pc?.close();
    this.pc = null;
    this.dc = null;

    try {
      await this.openConnection();
    } catch {
      handlers.onError('Voice reconnect failed');
    }
  }

  /**
   * Mute or unmute the mic track sent to OpenAI.
   * Call setMicMuted(true) when the examiner starts speaking to prevent
   * speaker echo from triggering OpenAI's VAD and cutting the response short.
   *
   * LEARN: track.enabled = false silences the track without stopping it.
   * The track's enabled state persists across reconnects because we reuse
   * the same MediaStreamTrack object — no need to re-apply after reconnect.
   */
  setMicMuted(muted: boolean): void {
    this.micStream?.getTracks().forEach(t => { t.enabled = !muted; });
  }

  /**
   * Clears any audio already buffered in OpenAI's input buffer.
   * Call this when the examiner starts speaking so echo that leaked in before
   * the mic mute took effect is discarded.
   */
  clearInputBuffer(): void {
    this.sendClientEvent({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Enable or disable OpenAI server-side VAD mid-session.
   */
  setVadPaused(paused: boolean): void {
    this.sendClientEvent({
      type: 'session.update',
      session: {
        turn_detection: paused ? null : { type: 'semantic_vad', eagerness: 'medium' },
      },
    });
  }

  /** Sends any client event JSON to OpenAI via the data channel. */
  private sendClientEvent(event: object): void {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(event));
    }
  }

  disconnect(): void {
    this.clientSecret = null;
    this.expiresAt = 0;
    this.activeHandlers = null;
    this.reconnectAttempts = 0;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.pendingUnmute) {
      clearTimeout(this.pendingUnmute);
      this.pendingUnmute = null;
    }

    // Stop mic tracks permanently — this is the only place we call track.stop().
    // handleIceFailure() intentionally skips this so the track survives reconnects.
    this.micStream?.getTracks().forEach(t => t.stop());
    this.micStream = null;

    this.pc?.close();
    this.pc = null;
    this.dc = null;

    if (this.remoteAudioEl) {
      this.remoteAudioEl.srcObject = null;
      // Remove from DOM to avoid orphaned elements if connect() is called again.
      this.remoteAudioEl.remove();
      this.remoteAudioEl = null;
    }
  }
}

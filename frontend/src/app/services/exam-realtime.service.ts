import { Injectable } from '@angular/core';

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** Server-event payloads vary by `type` — we only read the fields we need. */
type RealtimeServerEvent = {
  type?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
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
};

/**
 * Browser WebRTC session to OpenAI Realtime (`gpt-realtime-2`).
 *
 * LEARN: Mic audio goes out via `addTrack`; examiner audio returns on `ontrack`.
 * Text for transcripts (UI + grading) arrives on the `oai-events` data channel as JSON lines.
 */
@Injectable({ providedIn: 'root' })
export class ExamRealtimeService {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null; // kept so we can send client events after connect()
  private remoteAudioEl: HTMLAudioElement | null = null;

  /**
   * @param clientSecret from the backend (`ek_…`) — never the project's main API key.
   */
  async connect(clientSecret: string, handlers: ExamRealtimeHandlers): Promise<void> {
    this.disconnect();

    const pc = new RTCPeerConnection();
    this.pc = pc;

    this.remoteAudioEl = document.createElement('audio');
    this.remoteAudioEl.autoplay = true;
    // Must be in the DOM — detached audio elements can have playback silenced
    // or cut short by browser autoplay policy mid-sentence.
    this.remoteAudioEl.style.display = 'none';
    document.body.appendChild(this.remoteAudioEl);

    pc.ontrack = (e: RTCTrackEvent) => {
      if (this.remoteAudioEl) this.remoteAudioEl.srcObject = e.streams[0];
    };

    const ms = await navigator.mediaDevices.getUserMedia({
      audio: {
        // LEARN: These are standard browser DSP constraints applied BEFORE
        // audio is sent anywhere — the browser processes the raw mic signal first.
        echoCancellation: true,   // removes speaker output picked up by the mic
        noiseSuppression: true,   // filters steady-state noise (fan, AC hum, keyboard)
        autoGainControl: true,    // normalises volume so quiet speakers aren't missed
        sampleRate: 24000,        // match OpenAI Realtime's expected sample rate
      },
    });
    const [track] = ms.getTracks();
    pc.addTrack(track);

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc; // store so sendClientEvent() can reach it after connect() returns

    // Tracks whether we've already fired onExaminerAudioStart for the current
    // response — response.audio.delta fires once per chunk (many times), but
    // we only want to notify the caller on the very first chunk.
    let audioStartedThisResponse = false;

    dc.addEventListener('message', (e: MessageEvent<string>) => {
      let ev: RealtimeServerEvent;
      try {
        ev = JSON.parse(e.data) as RealtimeServerEvent;
      } catch {
        return;
      }
      const t = ev.type;

      // First audio chunk of a new examiner response — fire immediately so the
      // caller can mute the mic before any echo builds up in the input buffer.
      // LEARN: response.audio.delta carries raw base64 audio chunks as they stream.
      //   We ignore the chunk content here; we only care about the timing signal.
      if (t === 'response.audio.delta' && !audioStartedThisResponse) {
        audioStartedThisResponse = true;
        handlers.onExaminerAudioStart();
      }

      // Reset the flag when the response finishes so the next response fires again.
      if (t === 'response.done') {
        audioStartedThisResponse = false;
        handlers.onResponseDone();
      }

      if (t === 'conversation.item.input_audio_transcription.completed' && typeof ev.transcript === 'string') {
        const trimmed = ev.transcript.trim();
        if (trimmed) handlers.onCandidateTranscript(trimmed);
      }
      if (t === 'response.output_audio_transcript.done' && typeof ev.transcript === 'string') {
        const trimmed = ev.transcript.trim();
        if (trimmed) handlers.onExaminerTranscript(trimmed);
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
   * Mute or unmute the mic track sent to OpenAI.
   * Call setMicMuted(true) when the examiner starts speaking to prevent
   * speaker echo from triggering OpenAI's VAD and cutting the response short.
   */
  setMicMuted(muted: boolean): void {
    this.pc?.getSenders().forEach(s => {
      // LEARN: track.enabled = false silences the track without stopping it.
      // Stopping would end the WebRTC sender entirely — we want to resume it later.
      if (s.track) s.track.enabled = !muted;
    });
  }

  /**
   * Clears any audio already buffered in OpenAI's input buffer.
   *
   * Call this when the examiner starts speaking so any speaker echo that
   * already leaked into the buffer before the mic mute took effect is discarded.
   *
   * LEARN: The data channel is a bidirectional JSON event bus. We send client
   * events (like this one) to OpenAI; it sends server events back to us.
   */
  clearInputBuffer(): void {
    this.sendClientEvent({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Enable or disable OpenAI server-side VAD mid-session.
   *
   * - paused=true  → set turn_detection to null (OpenAI stops auto-detecting speech)
   * - paused=false → restore semantic_vad so OpenAI detects when the candidate finishes
   *
   * LEARN: session.update can change any session property at any time during the call.
   * Changes take effect immediately for the next audio processed.
   */
  setVadPaused(paused: boolean): void {
    this.sendClientEvent({
      type: 'session.update',
      session: {
        // LEARN: null disables server VAD; semantic_vad re-enables it.
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
    this.pc?.getSenders().forEach(s => s.track?.stop());
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    if (this.remoteAudioEl) {
      this.remoteAudioEl.srcObject = null;
      // Remove from DOM to avoid orphaned elements if connect() is called again
      this.remoteAudioEl.remove();
      this.remoteAudioEl = null;
    }
  }
}

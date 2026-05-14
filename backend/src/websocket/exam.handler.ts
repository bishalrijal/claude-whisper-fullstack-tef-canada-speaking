import type { Server } from 'http';
import { writeFile } from 'fs/promises';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { sessionRepository } from '../repositories/session.repository.js';
import {
  startAttempt,
  streamTurn,
  finishAttempt,
} from '../services/attempt.service.js';
import { ExamSession } from './exam.session.js';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SocketData,
  StartExamPayload,
  EndExamPayload,
} from './exam.types.js';

type ExamSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

function parseCookieHeader(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try { result[key] = decodeURIComponent(val); } catch { result[key] = val; }
  }
  return result;
}

async function handleStartExam(
  socket: ExamSocket,
  userId: string,
  payload: StartExamPayload,
): Promise<ExamSession> {
  const result = await startAttempt(payload.section, payload.scenarioId);

  const session = new ExamSession({
    userId,
    attemptId: result.attemptId,
    scenarioId: result.scenarioId,
    section: result.section,
    openingText: result.openingText,
  });

  socket.emit('exam_started', {
    attemptId: result.attemptId,
    scenarioId: result.scenarioId,
    scenarioImageUrl: result.scenarioImageUrl,
    openingText: result.openingText,
    openingAudio: result.openingAudio.toString('base64'),
  });

  return session;
}

async function handleAudioTurn(
  socket: ExamSocket,
  session: ExamSession,
  audioBuffer: Buffer,
): Promise<void> {
  const tmpPath = `/tmp/ws_audio_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`;
  await writeFile(tmpPath, audioBuffer);

  let examinerAccumText = '';

  // streamTurn internally deletes the temp file after Whisper transcription
  for await (const event of streamTurn(
    tmpPath,
    session.history,
    session.section,
    session.scenarioId,
  )) {
    switch (event.type) {
      case 'skipped':
        socket.emit('turn_done', { skipped: true });
        return;

      case 'transcript':
        session.history.push({ role: 'candidate', content: event.text });
        session.candidateDeliveryLog.push(event.delivery);
        socket.emit('transcript', { text: event.text, delivery: event.delivery });
        break;

      case 'audio':
        examinerAccumText += (examinerAccumText ? ' ' : '') + event.sentenceText;
        socket.emit('examiner_sentence', {
          sentenceText: event.sentenceText,
          audio: event.base64,
        });
        break;

      case 'done':
        if (examinerAccumText) {
          session.history.push({ role: 'examiner', content: examinerAccumText });
        }
        socket.emit('turn_done', { skipped: false });
        break;
    }
  }
}

async function handleEndExam(
  socket: ExamSocket,
  session: ExamSession,
  reason: 'timeout' | 'user_terminated',
): Promise<void> {
  const result = await finishAttempt(
    session.userId,
    session.history,
    [session.section],
    session.scenarioId,
    reason,
    session.candidateDeliveryLog,
  );

  socket.emit('exam_ended', {
    closingText: result.closingText,
    closingAudio: result.closingAudio.toString('base64'),
    evaluation: result.evaluation,
  });
}

export function registerExamNamespace(httpServer: Server): void {
  const appUrl = process.env['APP_URL'] ?? '';
  // Accept both the configured APP_URL and the localhost dev origin.
  // Also accept https:// variant automatically if APP_URL was written with http://.
  const allowedOrigins = [
    'http://localhost:4200',
    ...(appUrl ? [appUrl, appUrl.replace(/^http:/, 'https:')] : []),
  ].filter(Boolean);

  console.log('[ws] allowed CORS origins:', allowedOrigins);

  const io = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          console.warn(`[ws] CORS rejected origin: ${origin}`);
          callback(new Error(`Origin ${origin} not allowed`));
        }
      },
      credentials: true,
    },
  });

  const exam = io.of('/exam');

  exam.use(async (socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie ?? '';
    const cookies = parseCookieHeader(cookieHeader);
    const sessionId = cookies['sid'];
    if (!sessionId) {
      next(new Error('Unauthorized'));
      return;
    }
    const dbSession = await sessionRepository.findValidById(sessionId);
    if (!dbSession) {
      next(new Error('Unauthorized'));
      return;
    }
    socket.data.userId = dbSession.userId;
    next();
  });

  exam.on('connection', (socket) => {
    const typedSocket = socket as unknown as ExamSocket;
    let examSession: ExamSession | null = null;
    let turnInProgress = false;

    socket.on('start_exam', async (payload) => {
      try {
        examSession = await handleStartExam(typedSocket, socket.data.userId, payload);
      } catch {
        typedSocket.emit('error', { message: 'Failed to start exam' });
      }
    });

    socket.on('audio_submit', async (audioBuffer) => {
      if (!examSession || turnInProgress) return;
      turnInProgress = true;
      try {
        await handleAudioTurn(typedSocket, examSession, Buffer.from(audioBuffer));
      } catch (err) {
        console.error('[turn] handleAudioTurn failed:', err);
        typedSocket.emit('error', { message: 'Failed to process audio' });
      } finally {
        turnInProgress = false;
      }
    });

    socket.on('end_exam', async (payload: EndExamPayload) => {
      if (!examSession) return;
      const session = examSession;
      examSession = null;
      try {
        await handleEndExam(typedSocket, session, payload.reason);
      } catch {
        typedSocket.emit('error', { message: 'Failed to finish exam' });
      }
    });

    socket.on('disconnect', () => {
      examSession = null;
    });
  });
}

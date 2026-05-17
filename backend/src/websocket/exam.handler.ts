import type { Server } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { sessionRepository } from '../repositories/session.repository.js';
import { startAttempt, finishAttempt } from '../services/attempt.service.js';
import { createExamRealtimeClientSecret } from '../services/realtime-session.service.js';
import { ExamSession } from './exam.session.js';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SocketData,
  StartExamPayload,
  TranscriptUpdatePayload,
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

  // Ephemeral token + server-built instructions (persona + whisperHint + opening) for WebRTC.
  const { value, expires_at } = await createExamRealtimeClientSecret({
    userId,
    section: result.section,
    scenarioId: result.scenarioId,
  });

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
    realtime: { clientSecret: value, expiresAt: expires_at },
  });

  return session;
}

async function handleEndExam(
  socket: ExamSocket,
  session: ExamSession,
  payload: EndExamPayload,
): Promise<void> {
  console.log(`[exam] end_exam reason=${payload.reason} history=${session.history.length} turns`);

  const result = await finishAttempt(
    session.userId,
    session.history,
    [session.section],
    session.scenarioId,
    payload.reason,
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

    socket.on('start_exam', async (payload) => {
      try {
        examSession = await handleStartExam(typedSocket, socket.data.userId, payload);
      } catch {
        typedSocket.emit('error', { message: 'Failed to start exam' });
      }
    });

    socket.on('transcript_update', (payload: TranscriptUpdatePayload) => {
      if (!examSession) return;
      examSession.history.push({ role: payload.role, content: payload.content });
      console.log(`[exam] transcript_update role=${payload.role} len=${payload.content.length} history=${examSession.history.length}`);
    });

    socket.on('token_refresh', async () => {
      if (!examSession) return;
      try {
        const { value, expires_at } = await createExamRealtimeClientSecret({
          userId: examSession.userId,
          section: examSession.section,
          scenarioId: examSession.scenarioId,
        });
        typedSocket.emit('token_refreshed', { clientSecret: value, expiresAt: expires_at });
      } catch {
        typedSocket.emit('error', { message: 'Failed to refresh session token' });
      }
    });

    socket.on('end_exam', async (payload: EndExamPayload) => {
      if (!examSession) return;
      const session = examSession;
      examSession = null;
      try {
        await handleEndExam(typedSocket, session, payload);
      } catch {
        typedSocket.emit('error', { message: 'Failed to finish exam' });
      }
    });

    socket.on('disconnect', () => {
      examSession = null;
    });
  });
}

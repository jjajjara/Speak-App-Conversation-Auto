import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 기본 동작 상수 정의 (매직 넘버 방지)
export const DEFAULT_GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
];
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
export const DEFAULT_TTS_VOICE = 'en-US-JennyNeural';
export const DEFAULT_POLL_INTERVAL_MS = 2000; // 화면 상태 주기적 폴링 간격 (2초)
export const DEFAULT_TURN_COOLDOWN_MS = 8000; // 발화 후 Speak 앱 인식 및 상대방 응답 대기 시간 (8초)
export const DEFAULT_AUDIO_FILENAME = 'temp_reply.mp3';

// 재시도 및 지수 백오프 관련 상수
export const INITIAL_BACKOFF_MS = 3000;
export const MAX_BACKOFF_MS = 60000;
export const BACKOFF_MULTIPLIER = 2;
export const MAX_RETRY_COUNT = 5;

// 설정된 모델 리스트 파싱 함수
function parseModelList() {
  if (process.env.GEMINI_MODELS && process.env.GEMINI_MODELS.trim().length > 0) {
    return process.env.GEMINI_MODELS.split(',').map((m) => m.trim()).filter(Boolean);
  }
  if (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim().length > 0) {
    return [process.env.GEMINI_MODEL.trim()];
  }
  return DEFAULT_GEMINI_MODELS;
}

// 설정 객체 구성
export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModels: parseModelList(),
  geminiModel: parseModelList()[0] || DEFAULT_GEMINI_MODEL,
  ttsVoice: process.env.TTS_VOICE || DEFAULT_TTS_VOICE,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
  turnCooldownMs: Number(process.env.TURN_COOLDOWN_MS) || DEFAULT_TURN_COOLDOWN_MS,
  tempAudioPath: path.resolve(__dirname, '..', DEFAULT_AUDIO_FILENAME),
  adbPath: process.env.ADB_PATH || 'adb',
};

/**
 * 필수 환경 변수 및 설정값 유효성을 검증하는 함수
 * @throws {Error} 유효성 검증 실패 시 오류 발생
 */
export function validateConfig() {
  if (!config.geminiApiKey || config.geminiApiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 올바른 API 키를 입력해 주세요.');
  }

  if (config.pollIntervalMs < 500) {
    throw new Error('POLL_INTERVAL_MS는 최소 500ms 이상이어야 합니다.');
  }

  if (config.turnCooldownMs < 1000) {
    throw new Error('TURN_COOLDOWN_MS는 최소 1000ms 이상이어야 합니다.');
  }
}

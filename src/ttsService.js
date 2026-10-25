import { EdgeTTS } from '@andresaya/edge-tts';
import soundPlay from 'sound-play';
import fs from 'fs';
import { config } from './config.js';

// TTS 최대 재시도 횟수 및 딜레이 상수
const MAX_TTS_RETRY_COUNT = 3;
const TTS_RETRY_DELAY_MS = 1000;

/**
 * 지정된 시간(ms) 동안 비동기로 대기하는 헬퍼 함수
 * @param {number} delayMs 대기할 밀리초
 * @returns {Promise<void>}
 */
function waitDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 텍스트를 음성(MP3)으로 변환하여 지정된 파일 경로에 저장하는 함수
 * @param {string} text 음성으로 변환할 텍스트
 * @param {string} targetFilePath 저장할 오디오 파일 경로
 * @returns {Promise<string>} 생성된 파일 경로
 */
export async function synthesizeSpeech(text, targetFilePath = config.tempAudioPath) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('음성 변환을 위한 텍스트가 비어 있거나 유효하지 않습니다.');
  }

  const voice = config.ttsVoice || 'en-US-JennyNeural';
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_TTS_RETRY_COUNT; attempt++) {
    try {
      const tts = new EdgeTTS({ voice });
      await tts.synthesize(text.trim(), voice);
      await tts.toFile(targetFilePath);
      return targetFilePath;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_TTS_RETRY_COUNT) {
        console.warn(`[경고] TTS 음성 합성 일시적 실패 (시도 ${attempt}/${MAX_TTS_RETRY_COUNT}): ${error.message}. 재시도합니다...`);
        await waitDelay(TTS_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(`TTS 음성 합성 최종 실패 ("${text}"): ${lastError?.message || '알 수 없는 오류'}`);
}

/**
 * 오디오 파일을 재생하고 완료될 때까지 비동기로 대기하는 함수
 * @param {string} audioFilePath 재생할 오디오 파일 경로
 * @returns {Promise<void>}
 */
export async function playAudio(audioFilePath = config.tempAudioPath) {
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`재생할 오디오 파일이 존재하지 않습니다: ${audioFilePath}`);
  }

  try {
    // sound-play 패키지는 Windows에서 재생 완료 시 resolve되는 Promise를 반환합니다.
    await soundPlay.play(audioFilePath);
  } catch (error) {
    throw new Error(`오디오 재생 실패 (${audioFilePath}): ${error.message}`);
  }
}

/**
 * 영어 텍스트를 음성으로 합성하고 즉시 PC 스피커로 재생하는 통합 함수
 * @param {string} text 발화할 영어 텍스트
 * @returns {Promise<void>}
 */
export async function speakText(text) {
  const filePath = await synthesizeSpeech(text);
  await playAudio(filePath);
}

/**
 * 임시 생성된 오디오 파일을 삭제하는 정리 함수
 * @param {string} audioFilePath 삭제할 파일 경로
 */
export function cleanupTempAudio(audioFilePath = config.tempAudioPath) {
  try {
    if (fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
    }
  } catch (error) {
    // 종료 시점 정리 실패는 경고만 기록
    console.warn(`[경고] 임시 오디오 파일 삭제 중 오류 발생: ${error.message}`);
  }
}

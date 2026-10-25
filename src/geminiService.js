import { GoogleGenAI, Type } from '@google/genai';
import {
  config,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  BACKOFF_MULTIPLIER,
  MAX_RETRY_COUNT,
} from './config.js';

let geminiClientInstance = null;

/**
 * Gemini 클라이언트 인스턴스를 가져오거나 초기화하는 함수
 * @returns {GoogleGenAI}
 */
function getGeminiClient() {
  if (!geminiClientInstance) {
    if (!config.geminiApiKey) {
      throw new Error('Gemini API 키가 설정되지 않았습니다.');
    }
    geminiClientInstance = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return geminiClientInstance;
}

/**
 * 지정된 시간(ms)만큼 비동기로 대기하는 헬퍼 함수
 * @param {number} delayMs 대기할 밀리초
 * @returns {Promise<void>}
 */
function waitDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 에러 객체가 Rate Limit(429), 서버 과부하(503), 또는 일시적인 일시 오류인지 판별하는 함수
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableError(error) {
  if (!error) return false;
  const message = error.message || '';
  const status = error.status || error.code || 0;
  return (
    status === 429 ||
    status === 503 ||
    message.includes('429') ||
    message.includes('503') ||
    message.includes('UNAVAILABLE') ||
    message.includes('high demand') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.includes('quota') ||
    message.includes('rate limit')
  );
}

// Speak 화면 분석을 위한 정형화된 JSON 응답 스키마
const speakAnalysisResponseSchema = {
  type: Type.OBJECT,
  properties: {
    ready_to_speak: {
      type: Type.BOOLEAN,
      description:
        '사용자가 지금 답변을 말할 수 있는 상태인지 여부 (NEED_MIC_TAP 또는 ALREADY_RECORDING이면 true)',
    },
    input_mode: {
      type: Type.STRING,
      description:
        '발화 진입 모드: "NEED_MIC_TAP" (파란색 마이크 버튼을 탭해야 녹음 시작), "ALREADY_RECORDING" (이미 "지금 말하세요..." 파형/화살표가 활성화되어 바로 발화 가능), "WAITING" (상대방 발화 중이거나 대기 중)',
    },
    partner_question: {
      type: Type.STRING,
      description: '화면 속 AI 튜터의 가장 최근 영어 질문/발화 내용',
    },
    reply_text: {
      type: Type.STRING,
      description:
        'ready_to_speak가 true일 때 상대방 질문 또는 대화 흐름에 맞춘 1~2문장의 자연스럽고 명확한 영어 답변. 말할 차례가 아니면 빈 문자열.',
    },
    current_status: {
      type: Type.STRING,
      description:
        '화면 상태 요약 (READY_TO_RECORD, RECORDING, AI_SPEAKING, LOADING, FEEDBACK, OTHER)',
    },
  },
  required: ['ready_to_speak', 'input_mode', 'partner_question', 'reply_text', 'current_status'],
};

// 화면 분석을 위한 시스템 프롬프트
const SYSTEM_PROMPT = `당신은 영어 회화 앱 'Speak'의 화면을 실시간으로 분석하여 대화 봇을 보조하는 전문가입니다.
주어진 모바일 스크린샷 이미지를 분석하고 다음 규칙에 따라 정확한 JSON을 반환하세요:

1. input_mode 및 ready_to_speak 판별:
   - "ALREADY_RECORDING": 화면에 "지금 말하세요...", 오디오 파형, 하단 중앙에 위쪽 파란색 화살표(↑) 전송 버튼이 이미 표시되어 있는 상태입니다. (ready_to_speak = true)
   - "NEED_MIC_TAP": 화면 하단 중앙에 파란색 원형 마이크 아이콘이 보이고, "녹음 버튼을 누르세요" 또는 "탭하여 녹음 시작하기" 안내가 표시된 발화 대기 상태입니다. (ready_to_speak = true)
   - "WAITING": 상대방 AI 튜터가 아직 말하는 중이거나, 로딩 중이거나, 피드백/결과 화면이어서 사용자가 말할 차례가 아닌 상태입니다. (ready_to_speak = false)

2. partner_question:
   - 상대방(AI 튜터)의 가장 최근 말풍선에 적힌 영어 텍스트를 그대로 추출하세요.

3. reply_text:
   - ready_to_speak가 true인 경우, 상대방의 질문에 대답하는 1~2문장의 자연스러운 구어체 영어 문장을 생성하세요.
   - 친절하고 직관적인 원어민 스타일로 작성하고, 불필요한 군더더기 없이 실제 대화하듯 작성하세요.
   - 발화 차례가 아니면 빈 문자열("")을 반환하세요.

4. current_status:
   - "READY_TO_RECORD" (마이크 버튼 대기 상태)
   - "RECORDING" (이미 녹음 모드 / "지금 말하세요...")
   - "AI_SPEAKING" (상대방 AI 말하는 중)
   - "FEEDBACK" (채점 및 피드백)
   - "OTHER" (기타)`;

let currentModelIndex = 0;

/**
 * 현재 활성화된 Gemini 모델 이름을 반환하는 함수
 * @returns {string}
 */
export function getCurrentModel() {
  const models = config.geminiModels;
  return models[currentModelIndex % models.length];
}

/**
 * 다음 모델로 전환하고 전환된 모델명을 반환하는 함수
 * @param {string} reason 전환 사유
 * @returns {string} 새로 전환된 모델 이름
 */
export function switchToNextModel(reason = '') {
  const models = config.geminiModels;
  const oldModel = getCurrentModel();
  currentModelIndex = (currentModelIndex + 1) % models.length;
  const newModel = getCurrentModel();

  console.warn(
    `\n🔄 [모델 자동 전환] "${oldModel}" 한도 도달 또는 오류 (${reason}) ➔ 다음 모델 "${newModel}" 로 즉시 전환합니다.\n`
  );
  return newModel;
}

/**
 * 스크린샷 Base64 이미지를 Gemini Multimodal API로 분석하여 답변과 상태를 도출하는 함수
 * Rate Limit(429) 또는 할당량 초과 발생 시 모델 풀의 다음 모델로 즉시 전환하여 연속성을 보장합니다.
 * @param {string} base64Image Base64 인코딩된 스크린샷 문자열
 * @returns {Promise<{ ready_to_speak: boolean, input_mode: string, partner_question: string, reply_text: string, current_status: string }>}
 */
export async function analyzeScreenAndGenerateReply(base64Image) {
  if (!base64Image || typeof base64Image !== 'string' || base64Image.trim().length === 0) {
    throw new Error('유효하지 않은 Base64 이미지 데이터입니다.');
  }

  const ai = getGeminiClient();
  let currentDelay = INITIAL_BACKOFF_MS;
  const totalModelsCount = config.geminiModels.length;

  for (let attempt = 1; attempt <= MAX_RETRY_COUNT; attempt++) {
    const activeModel = getCurrentModel();

    try {
      const response = await ai.models.generateContent({
        model: activeModel,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: base64Image,
                },
              },
              {
                text: '이 Speak 앱 화면을 분석하여 발화 가능 여부와 최적의 영어 답변을 JSON으로 반환해주세요.',
              },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: speakAnalysisResponseSchema,
          temperature: 0.2, // 일관된 고품질 응답을 위해 낮은 온도 유지
        },
      });

      const responseText = response.text ? response.text.trim() : '';
      if (!responseText) {
        throw new Error('Gemini API로부터 빈 응답이 수신되었습니다.');
      }

      const parsedData = JSON.parse(responseText);

      // 응답 데이터 필드 검증
      return {
        ready_to_speak: Boolean(parsedData.ready_to_speak),
        input_mode: String(parsedData.input_mode || 'WAITING').toUpperCase(),
        partner_question: String(parsedData.partner_question || '').trim(),
        reply_text: String(parsedData.reply_text || '').trim(),
        current_status: String(parsedData.current_status || 'UNKNOWN').toUpperCase(),
      };
    } catch (error) {
      const message = error.message || '';
      const isQuotaExceeded =
        message.includes('Quota exceeded') ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('limit: 20') ||
        message.includes('quota');

      // 모델 리스트가 여러 개 있고 할당량 초과 시 -> 다음 모델로 즉시 전환 후 지연 없이 바로 재시도!
      if (isQuotaExceeded && totalModelsCount > 1) {
        switchToNextModel('할당량 소진 Quota Exceeded');
        continue;
      }

      const isRetryable = isRetryableError(error);

      if (isRetryable && attempt < MAX_RETRY_COUNT) {
        console.warn(
          `[경고] 모델 [${activeModel}] 일시적 부하 감지: ${message.substring(0, 100)}...\n${currentDelay / 1000}초 후 재시도합니다... (시도 ${attempt}/${MAX_RETRY_COUNT})`
        );
        await waitDelay(currentDelay);
        currentDelay = Math.min(currentDelay * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      } else {
        // 단일 모델 오류 시에도 다른 모델이 남아있다면 다음 모델로 전환 시도
        if (totalModelsCount > 1 && attempt < MAX_RETRY_COUNT) {
          switchToNextModel('오류 발생');
          continue;
        }
        throw new Error(`Gemini 화면 분석 실패 (모델 ${activeModel}, 시도 ${attempt}): ${error.message}`);
      }
    }
  }

  throw new Error(`Gemini API 호출 최대 재시도 횟수(${MAX_RETRY_COUNT})를 초과했습니다.`);
}

import chalk from 'chalk';
import { config, validateConfig } from './config.js';
import {
  checkDeviceConnection,
  captureScreenBase64,
  tapScreen,
  getActionCoordinates,
  keepScreenOn,
  wakeScreen,
  startScreenKeeper,
  stopScreenKeeper,
} from './adbService.js';
import { analyzeScreenAndGenerateReply, getCurrentModel } from './geminiService.js';
import { speakText, cleanupTempAudio } from './ttsService.js';

let isRunning = true;
let turnCount = 0;
let stuckRecordingCount = 0; // 녹음 상태 정체 감지 카운터

// 상호작용 관련 딜레이 상수 (매직 넘버 방지)
const MIC_ACTIVATION_WAIT_MS = 1600; // 마이크 버튼 탭 후 녹음 활성화 및 수음 준비 대기 시간
const SPEECH_FINISH_WAIT_MS = 1000; // 발화 후 마이크 수음 완료 및 버퍼 정리 대기 시간
const MAX_STUCK_RECORDING_COUNT = 2; // 녹음 상태 정체 허용 횟수

/**
 * 지정된 시간(ms) 동안 대기하는 헬퍼 함수
 * @param {number} ms 대기 시간 (밀리초)
 * @returns {Promise<void>}
 */
function waitDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 터미널에 환영 메시지 및 현재 설정을 출력하는 함수
 * @param {string} deviceId 연결된 안드로이드 디바이스 ID
 */
function printBanner(deviceId) {
  console.clear();
  console.log(chalk.bold.hex('#A78BFA')('=================================================='));
  console.log(chalk.bold.hex('#C084FC')('   🤖 Speak 앱 영어 대화 자동화 봇 (Speak-Auto)   '));
  console.log(chalk.bold.hex('#A78BFA')('=================================================='));
  console.log(chalk.cyan(`[디바이스] `) + chalk.white(`${deviceId}`));
  console.log(chalk.cyan(`[활성모델] `) + chalk.yellow.bold(`${getCurrentModel()}`));
  console.log(chalk.cyan(`[모델풀]   `) + chalk.white(`${config.geminiModels.join(', ')}`));
  console.log(chalk.cyan(`[음성]     `) + chalk.white(`${config.ttsVoice}`));
  console.log(chalk.cyan(`[폴링주기] `) + chalk.white(`${config.pollIntervalMs}ms`));
  console.log(chalk.cyan(`[발화대기] `) + chalk.white(`${config.turnCooldownMs}ms`));
  console.log(chalk.green(`[화면유지] `) + chalk.white(`USB 화면 켜짐 유지 & 1.5초 주기 키퍼 가동`));
  console.log(chalk.gray('종료하려면 언제든지 Ctrl + C를 누르세요.\n'));
}

/**
 * 현재 화면 분석 상태 로그를 출력하는 함수
 * @param {string} status 화면 상태 문자열
 * @param {boolean} readyToSpeak 발화 대기 여부
 */
function logScreenStatus(status, readyToSpeak) {
  const timestamp = new Date().toLocaleTimeString('ko-KR');
  const statusColor = readyToSpeak ? chalk.green.bold : chalk.yellow;
  const statusLabel = readyToSpeak ? '대기 중 (발화 가능)' : '진행 중 / 듣는 중';

  console.log(
    chalk.gray(`[${timestamp}] `) +
      chalk.blueBright(`화면 상태: `) +
      statusColor(`[${status}]`) +
      chalk.gray(` - ${statusLabel}`)
  );
}

/**
 * 봇 발화 및 진행 상황 로그를 출력하는 함수
 * @param {number} turn 턴 번호
 * @param {string} partnerQuestion 상대방 질문 내용
 * @param {string} replyText 생성된 영어 답변
 */
function logTurnAction(turn, partnerQuestion, replyText) {
  console.log(chalk.bold.hex('#F59E0B')(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
  console.log(chalk.bold.hex('#34D399')(`✨ [대화 턴 #${turn}]`));
  if (partnerQuestion) {
    console.log(chalk.cyan(`   🤖 튜터 질문: `) + chalk.white(`"${partnerQuestion}"`));
  }
  console.log(chalk.greenBright(`   🗣️  내 답변:   `) + chalk.bold.white(`"${replyText}"`));
  console.log(chalk.bold.hex('#F59E0B')(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
}

/**
 * 정상 종료 및 자원 정리 핸들러를 등록하는 함수
 */
function setupGracefulShutdown() {
  const handleExit = async () => {
    console.log(chalk.bold.magenta('\n\n🛑 사용자 요청으로 자동화 봇을 종료합니다.'));
    isRunning = false;
    stopScreenKeeper(); // 화면 유지 백그라운드 타이머 정지
    await keepScreenOn(false); // 화면 켜짐 유지 해제 및 타임아웃 복원
    cleanupTempAudio();
    console.log(chalk.green('✔ 화면 설정 복원 및 임시 오디오 파일 정리 완료. 안녕히 가세요!'));
    process.exit(0);
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}

/**
 * 대화 자동화 메인 루프 함수
 * @param {{ x: number, y: number }} actionCoords 마이크 및 화살표 버튼 화면 좌표
 */
async function runAutomationLoop(actionCoords) {
  while (isRunning) {
    try {
      // 화면이 꺼져있을 경우 즉시 깨우기
      await wakeScreen();

      // 1. ADB로 화면을 인메모리 Base64로 캡처
      const base64Image = await captureScreenBase64();

      // 2. Gemini Multimodal에 화면을 전달하여 분석
      const analysisResult = await analyzeScreenAndGenerateReply(base64Image);
      const {
        ready_to_speak: readyToSpeak,
        input_mode: inputMode,
        partner_question: partnerQuestion,
        reply_text: replyText,
        current_status: currentStatus,
      } = analysisResult;

      // 화면 상태 로깅
      logScreenStatus(currentStatus, readyToSpeak);

      // 녹음 상태(RECORDING) 멈춤 감지 및 자동 복구 로직 (이미 녹음 모드에서 3회 이상 멈출 경우)
      if (currentStatus === 'RECORDING' && !readyToSpeak) {
        stuckRecordingCount += 1;
        if (stuckRecordingCount >= MAX_STUCK_RECORDING_COUNT) {
          console.log(
            chalk.yellow.bold(
              `⚠️ 녹음 상태 정체 감지: 전송(화살표) 버튼을 다시 탭하여 복구합니다. (${actionCoords.x}, ${actionCoords.y})`
            )
          );
          await tapScreen(actionCoords.x, actionCoords.y);
          stuckRecordingCount = 0;
          await waitDelay(2000);
          continue;
        }
      } else {
        stuckRecordingCount = 0;
      }

      // 3. 발화 가능 상태이고 답변이 준비된 경우 Speak 상호작용 실행
      if (readyToSpeak && replyText.length > 0) {
        turnCount += 1;
        logTurnAction(turnCount, partnerQuestion, replyText);

        if (inputMode === 'NEED_MIC_TAP') {
          // [단계 1] 파란색 마이크 버튼 탭하여 녹음 모드 켜기
          console.log(chalk.blue(`   [1/3] 🎙️  마이크 버튼 탭 (${actionCoords.x}, ${actionCoords.y})`));
          await tapScreen(actionCoords.x, actionCoords.y);

          // Speak 앱이 오디오 장치를 열고 "지금 말하세요..." 파형을 띄울 때까지 안정적으로 대기
          console.log(chalk.gray(`   ⏳ 녹음 준비 대기 (${MIC_ACTIVATION_WAIT_MS}ms)...`));
          await waitDelay(MIC_ACTIVATION_WAIT_MS);
        } else {
          // 이미 녹음 모드(ALREADY_RECORDING)인 경우, 마이크 버튼을 절대 누르지 않고 바로 발화!
          console.log(chalk.cyan(`   ⚡ 앱이 이미 "지금 말하세요..." 대기 상태입니다. (마이크 탭 생략)`));
          await waitDelay(400); // UI 안정화 400ms
        }

        // [단계 2] TTS로 음성 합성 후 PC 스피커로 재생 (마이크가 수음하도록)
        console.log(chalk.magenta(`   [2/3] 🔊 음성 출력 중: "${replyText}"`));
        await speakText(replyText);

        // 마이크 수음 버퍼가 비워지고 마지막 음절까지 확실히 인식되도록 대기
        console.log(chalk.gray(`   ⏳ 발화 완료 및 수음 안정화 대기 (${SPEECH_FINISH_WAIT_MS}ms)...`));
        await waitDelay(SPEECH_FINISH_WAIT_MS);

        // [단계 3] 위쪽 화살표(전송) 버튼 탭하여 발화 내용 제출
        console.log(chalk.yellow(`   [3/3] 📤 전송(화살표) 버튼 탭 (${actionCoords.x}, ${actionCoords.y})`));
        await tapScreen(actionCoords.x, actionCoords.y);

        console.log(
          chalk.hex('#818CF8')(
            `\n⏳ Speak 앱의 음성 인식 및 상대방 발화 완료를 위해 ${config.turnCooldownMs / 1000}초간 대기합니다...\n`
          )
        );

        // 한 턴 발화 및 전송 후 Speak 앱 처리 대기
        await waitDelay(config.turnCooldownMs);
      } else {
        // 발화 대기 상태가 아닐 때는 설정된 폴링 주기만큼 대기
        await waitDelay(config.pollIntervalMs);
      }
    } catch (error) {
      console.error(chalk.red.bold(`\n❌ 오류 발생: ${error.message}`));
      console.log(chalk.gray(`다시 시도하기 위해 ${config.pollIntervalMs}ms 동안 대기합니다...\n`));
      await waitDelay(config.pollIntervalMs);
    }
  }
}

/**
 * 프로그램 시작 진입점 함수
 */
async function main() {
  setupGracefulShutdown();

  try {
    // 환경 설정 검증
    validateConfig();

    console.log(chalk.cyan('📱 ADB 연결 기기 및 화면 상태를 확인하는 중입니다...'));
    const deviceId = await checkDeviceConnection();
    const actionCoords = await getActionCoordinates();

    // USB 연결 중 화면 꺼짐 방지 활성화, 30분 연장 및 1.5초 주기 키퍼 시작
    await keepScreenOn(true);
    await wakeScreen();
    startScreenKeeper(1500);

    printBanner(deviceId);
    console.log(chalk.cyan(`[버튼위치] `) + chalk.white(`X: ${actionCoords.x}, Y: ${actionCoords.y}`));
    console.log(chalk.green('▶ Speak 앱 자동화 루프를 시작합니다.\n'));

    await runAutomationLoop(actionCoords);
  } catch (error) {
    console.error(chalk.red.bold(`\n초기화 실패: ${error.message}`));
    cleanupTempAudio();
    process.exit(1);
  }
}

main();

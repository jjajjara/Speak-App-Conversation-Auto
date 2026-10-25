import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PNG 파일 헤더 및 IEND 청크 시그니처 바이트 상수 정의
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_SIGNATURE = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

let resolvedAdbPath = null;

/**
 * 시스템 또는 지정된 경로에서 유효한 adb 실행 파일 경로를 찾아 반환하는 함수
 * @returns {string} adb 실행 경로
 */
export function resolveAdbPath() {
  if (resolvedAdbPath) {
    return resolvedAdbPath;
  }

  // 1. .env에 명시적으로 ADB_PATH가 지정되어 있고 파일이 존재하는 경우
  if (config.adbPath && config.adbPath !== 'adb' && fs.existsSync(config.adbPath)) {
    resolvedAdbPath = config.adbPath;
    return resolvedAdbPath;
  }

  // 2. 프로젝트 로컬 및 기본 경로 순차 탐색 (로컬 platform-tools 우선)
  const candidatePaths = [
    path.resolve(__dirname, '..', 'platform-tools', 'adb.exe'),
    path.resolve(__dirname, '..', 'adb.exe'),
    'C:\\Users\\jjajj\\Downloads\\platform-tools-latest-windows\\platform-tools\\adb.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe')
      : null,
  ].filter(Boolean);

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      resolvedAdbPath = candidate;
      return resolvedAdbPath;
    }
  }

  // 3. 후보가 없으면 시스템 PATH의 기본 'adb' 사용
  resolvedAdbPath = config.adbPath || 'adb';
  return resolvedAdbPath;
}

/**
 * ADB 연결된 기기 목록을 확인하고 사용 가능한 디바이스 ID를 반환하는 함수
 * @returns {Promise<string>} 연결된 첫 번째 디바이스 ID
 */
export async function checkDeviceConnection() {
  const adbCmd = resolveAdbPath();
  const command = adbCmd.includes(' ') ? `"${adbCmd}" devices` : `${adbCmd} devices`;

  try {
    const { stdout, stderr } = await execAsync(command);

    if (stderr && stderr.trim().length > 0) {
      throw new Error(`ADB 오류: ${stderr}`);
    }

    const lines = stdout.trim().split('\n').slice(1);
    const devices = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.endsWith('\tdevice'))
      .map((line) => line.split('\t')[0]);

    if (devices.length === 0) {
      throw new Error('연결된 안드로이드 기기를 찾을 수 없습니다. USB 디버깅 활성화 및 케이블 연결 상태를 확인해 주세요.');
    }

    return devices[0];
  } catch (error) {
    if (error.code === 'ENOENT' || error.message.includes('not found') || error.message.includes('인식할 수 없는')) {
      throw new Error(
        `adb 실행 파일을 찾을 수 없습니다. 현재 시도 경로: [${adbCmd}].\n.env에 ADB_PATH=...를 지정하거나 platform-tools 폴더를 복사해 주세요.`
      );
    }
    throw error;
  }
}

/**
 * 버퍼 데이터가 유효한 PNG 포맷인지 확인하는 함수
 * @param {Buffer} buffer 검사할 이미지 버퍼
 * @returns {boolean} 유효 여부
 */
function isValidPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_HEADER.length + PNG_IEND_SIGNATURE.length) {
    return false;
  }

  // PNG 헤더 일치 여부 확인
  const isHeaderValid = buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER);
  if (!isHeaderValid) {
    return false;
  }

  // 끝부분에 IEND 청크가 포함되어 있는지 확인
  const tailBuffer = buffer.subarray(buffer.length - 12);
  return tailBuffer.includes(Buffer.from('IEND'));
}

/**
 * ADB exec-out screencap을 실행하여 인메모리 Base64 PNG 이미지 문자열을 반환하는 함수
 * @returns {Promise<string>} Base64 인코딩된 PNG 이미지 데이터
 */
export function captureScreenBase64() {
  return new Promise((resolve, reject) => {
    const adbCmd = resolveAdbPath();
    const adbProcess = spawn(adbCmd, ['exec-out', 'screencap', '-p']);
    const chunks = [];
    let stderrMessage = '';

    adbProcess.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    adbProcess.stderr.on('data', (data) => {
      stderrMessage += data.toString();
    });

    adbProcess.on('error', (err) => {
      reject(new Error(`ADB 스크린캡처 프로세스 시작 실패: ${err.message}`));
    });

    adbProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ADB 스크린캡처 종료 코드 ${code}: ${stderrMessage.trim()}`));
      }

      const completeBuffer = Buffer.concat(chunks);

      if (!isValidPngBuffer(completeBuffer)) {
        return reject(new Error('불완전하거나 손상된 PNG 화면 캡처 데이터가 수신되었습니다.'));
      }

      const base64Image = completeBuffer.toString('base64');
      resolve(base64Image);
    });
  });
}

/**
 * 화면의 특정 좌표를 터치하는 함수
 * @param {number} x X 좌표
 * @param {number} y Y 좌표
 * @returns {Promise<void>}
 */
export async function tapScreen(x, y) {
  // 좌표값 유효성 검증
  if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y) || x < 0 || y < 0) {
    throw new Error(`유효하지 않은 터치 좌표입니다: (${x}, ${y})`);
  }

  const safeX = Math.round(x);
  const safeY = Math.round(y);
  const adbCmd = resolveAdbPath();
  const command = adbCmd.includes(' ')
    ? `"${adbCmd}" shell input tap ${safeX} ${safeY}`
    : `${adbCmd} shell input tap ${safeX} ${safeY}`;

  try {
    await execAsync(command);
  } catch (error) {
    throw new Error(`화면 터치 실행 실패 (${safeX}, ${safeY}): ${error.message}`);
  }
}

/**
 * 디바이스의 물리 화면 해상도를 조회하는 함수
 * @returns {Promise<{ width: number, height: number }>}
 */
export async function getScreenResolution() {
  const adbCmd = resolveAdbPath();
  const command = adbCmd.includes(' ') ? `"${adbCmd}" shell wm size` : `${adbCmd} shell wm size`;

  try {
    const { stdout } = await execAsync(command);
    const match = stdout.match(/(\d+)x(\d+)/);
    if (match) {
      return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      };
    }
    return { width: 1080, height: 2340 };
  } catch {
    return { width: 1080, height: 2340 };
  }
}

/**
 * Speak 앱 하단 마이크 및 전송(화살표) 버튼의 좌표를 계산하여 반환하는 함수
 * @returns {Promise<{ x: number, y: number }>}
 */
export async function getActionCoordinates() {
  const { width, height } = await getScreenResolution();
  // 화면 하단 중앙 원형 버튼 비율 (가로 50%, 세로 약 86.8%)
  const x = Math.round(width * 0.5);
  const y = Math.round(height * 0.8675);
  return { x, y };
}

let screenKeeperIntervalId = null;
let originalScreenTimeout = null;

/**
 * USB 연결 중 화면이 꺼지지 않도록 설정하거나 해제하는 함수
 * @param {boolean} enable 활성화 여부
 * @returns {Promise<void>}
 */
export async function keepScreenOn(enable = true) {
  const adbCmd = resolveAdbPath();
  const stayonCmd = enable ? 'true' : 'false';
  const plugVal = enable ? '3' : '0'; // 3: AC + USB 충전 중 화면 켜짐 유지

  try {
    const cmd1 = adbCmd.includes(' ') ? `"${adbCmd}" shell svc power stayon ${stayonCmd}` : `${adbCmd} shell svc power stayon ${stayonCmd}`;
    const cmd2 = adbCmd.includes(' ') ? `"${adbCmd}" shell settings put global stay_on_while_plugged_in ${plugVal}` : `${adbCmd} shell settings put global stay_on_while_plugged_in ${plugVal}`;
    await execAsync(cmd1);
    await execAsync(cmd2);

    if (enable) {
      // 화면 자동 꺼짐 시간을 30분(1800000ms)으로 임시 연장
      const getTimeoutCmd = adbCmd.includes(' ') ? `"${adbCmd}" shell settings get system screen_off_timeout` : `${adbCmd} shell settings get system screen_off_timeout`;
      const { stdout } = await execAsync(getTimeoutCmd);
      if (stdout && !isNaN(parseInt(stdout.trim(), 10))) {
        originalScreenTimeout = stdout.trim();
      }
      const setTimeoutCmd = adbCmd.includes(' ') ? `"${adbCmd}" shell settings put system screen_off_timeout 1800000` : `${adbCmd} shell settings put system screen_off_timeout 1800000`;
      await execAsync(setTimeoutCmd);
    } else if (originalScreenTimeout) {
      // 종료 시 원래 설정으로 복원
      const restoreTimeoutCmd = adbCmd.includes(' ') ? `"${adbCmd}" shell settings put system screen_off_timeout ${originalScreenTimeout}` : `${adbCmd} shell settings put system screen_off_timeout ${originalScreenTimeout}`;
      await execAsync(restoreTimeoutCmd);
    }
  } catch (error) {
    console.warn(`[경고] 화면 켜짐 유지 설정 실패: ${error.message}`);
  }
}

/**
 * 화면이 꺼져있을 경우 화면을 깨우고 잠금을 해제하는 함수
 * @returns {Promise<void>}
 */
export async function wakeScreen() {
  const adbCmd = resolveAdbPath();

  try {
    const wakeCmd = adbCmd.includes(' ') ? `"${adbCmd}" shell input keyevent 224` : `${adbCmd} shell input keyevent 224`;
    const dismissCmd = adbCmd.includes(' ') ? `"${adbCmd}" shell wm dismiss-keyguard` : `${adbCmd} shell wm dismiss-keyguard`;
    await execAsync(wakeCmd);
    await execAsync(dismissCmd);
  } catch (error) {
    console.warn(`[경고] 화면 깨우기 실패: ${error.message}`);
  }
}

/**
 * 매 N초마다 백그라운드에서 화면 깨우기 신호를 지속 전송하는 키퍼 시작 함수
 * @param {number} intervalMs 반복 간격 (밀리초)
 */
export function startScreenKeeper(intervalMs = 2000) {
  if (screenKeeperIntervalId) return;

  screenKeeperIntervalId = setInterval(() => {
    wakeScreen().catch(() => {});
  }, intervalMs);
}

/**
 * 화면 유지 백그라운드 키퍼를 정지하는 함수
 */
export function stopScreenKeeper() {
  if (screenKeeperIntervalId) {
    clearInterval(screenKeeperIntervalId);
    screenKeeperIntervalId = null;
  }
}

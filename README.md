# Speak 앱 영어 대화 자동화 봇 (Speak-Auto)

Windows 환경에서 USB로 연결된 안드로이드 기기의 Speak 앱 화면을 실시간 캡처하고, Google Gemini Multimodal API(`@google/genai`)를 통해 상대방 질문과 발화 타이밍을 분석하여 최신 MS Edge 신경망 TTS로 음성을 자동 출력하는 완전 자동화 시스템입니다.

---

## 🛠️ 핵심 기능 및 개선 내역

- **초고속 인메모리 화면 캡처 & 자동 ADB 감지 (`adbService.js`)**:
  - 디스크 I/O 없이 `adb exec-out screencap -p` 스트림을 메모리 버퍼로 합쳐 Base64 이미지로 처리합니다.
  - 프로젝트 내 `platform-tools/adb.exe` 또는 시스템 경로를 자동으로 탐색하여 별도 환경변수 설정 없이 동작합니다.
- **이중 화면 꺼짐 원천 차단 (`adbService.js`, `index.js`)**:
  - 시스템 화면 자동 꺼짐 시간을 **30분(1,800,000ms)**으로 자동 연장합니다. (종료 시 원래 설정으로 복원)
  - **1.5초 주기 백그라운드 키퍼(Heartbeat)**가 지속적으로 화면 깨우기 신호(`keyevent 224` & 잠금해제)를 전송하여 화면이 절전 모드로 들어가는 것을 원천 방지합니다.
- **Speak 앱 맞춤형 지능형 발화 시퀀스 (`geminiService.js`, `index.js`)**:
  - **상태 A (`ALREADY_RECORDING`)**: 상대방 말이 끝난 후 폰이 이미 "지금 말하세요..."(파란 화살표 전송 버튼) 상태이면 **마이크 탭을 생략하고 즉시 발화**하여 조기 전송 오류를 방지합니다.
  - **상태 B (`NEED_MIC_TAP`)**: "녹음 버튼을 누르세요" 상태이면 **마이크 버튼 탭 ➡️ 1,600ms 안정 대기 ➡️ 발화 ➡️ 1,000ms 수음 안정화 대기 ➡️ 전송(화살표) 버튼 탭**의 정밀 시퀀스를 실행합니다.
  - **녹음 정체 자동 복구 (Stuck Recovery)**: 녹음 모드에서 2회 이상 멈출 경우 전송 버튼을 재터치하여 세션을 자동 복구합니다.
- **멀티 Gemini 모델 풀 및 429 Failover 자동 전환 (`geminiService.js`, `config.js`)**:
  - Google Free Tier의 모델별 일일 할당량 제한(RPD)을 극복하기 위해 우선순위 모델 풀(`gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.7-flash`, `gemini-3.8-flash`)을 운영합니다.
  - 특정 모델이 한도 초과(429/RESOURCE_EXHAUSTED)에 도달하면 대기 없이 **즉시 다음 모델로 자동 전환(Failover)**하여 24시간 끊김 없이 대화를 유지합니다.
- **최신 고음질 신경망 TTS (`ttsService.js`)**:
  - 최신 Microsoft Edge 핸드셰이크 토큰 알고리즘을 지원하는 `@andresaya/edge-tts`를 적용하여 403 Forbidden 오류 없이 안정적으로 고품질 음성(`en-US-JennyNeural`)을 합성합니다.
  - 호출별 격리 인스턴스화 및 자동 재시도 로직을 통해 소켓 끊김이나 객체 오염을 방지합니다.
- **`Ctrl+C` 안전 종료 (Graceful Shutdown)**:
  - 사용자 종료 시 화면 유지 타이머 정지, 화면 타임아웃 설정 복원, 임시 오디오 파일(`.mp3`) 삭제를 안전하게 수행합니다.

---

## 📋 시작하기 전에 준비할 사항

1. **Node.js**: v18 이상 LTS 설치
2. **Android 기기 설정**:
   - 휴대폰에서 **개발자 옵션 > USB 디버깅** 활성화
   - PC와 스마트폰을 USB 케이블로 연결
   - 프로젝트 내 `platform-tools/` 폴더에 `adb.exe`를 두거나 시스템 PATH에 등록
3. **스마트폰 마이크 & PC 스피커 환경**:
   - 스마트폰을 PC 스피커 가까이에 두고, 스피커 볼륨을 적절히 조절합니다.

---

## 🚀 설치 및 실행 방법

### 1. 패키지 설치
```bash
npm install
```

### 2. 환경 변수 설정
`.env.example` 파일을 복사하여 `.env` 파일을 생성하고 Gemini API 키를 입력합니다:
```bash
cp .env.example .env
```

`.env` 파일 내용:
```env
# Google Gemini API 키 (필수)
GEMINI_API_KEY=AIzaSy...

# 모델 리스트 설정 (우선순위 순서대로 콤마 구분, 429 시 다음 모델로 자동 전환)
GEMINI_MODELS=gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.8-flash

# TTS 보이스 (기본값: en-US-JennyNeural)
TTS_VOICE=en-US-JennyNeural

# 상태 감지 폴링 주기 (ms)
POLL_INTERVAL_MS=2000

# 한 턴 발화 후 상대방 응답 대기 시간 (ms)
TURN_COOLDOWN_MS=8000
```

### 3. Speak 앱 실행
스마트폰에서 Speak 앱을 열고 AI 튜터와의 대화 모드(Free Talk 또는 롤플레잉 세션)를 시작합니다.

### 4. 자동화 봇 실행
```bash
npm start
```

종료하려면 터미널에서 `Ctrl + C`를 누르시면 됩니다.

# 🤖 Speak 앱 영어 대화 자동화 (Speak-App-Conversation-Auto)

Windows 환경에서 USB로 연결된 안드로이드 기기의 **스마트폰 화면을 실시간 캡처(ADB Stream)**하고, **Google Gemini 3.x Multimodal API**로 튜터의 질문과 발화 타이밍을 분석한 뒤, **Microsoft Edge 고품질 신경망 TTS**로 음성을 자동 출력하여 Speak 앱의 대화 미션을 전자동으로 완료하는 Node.js 자동화 봇입니다.

---

## 🌟 주요 기능 및 핵심 아키텍처

```
[안드로이드 스마트폰]                      [PC (Node.js Automation)]
   Speak 앱 실행                              
        │                                         │
        ├──── (1) 실시간 화면 캡처 (ADB) ─────────▶│
        │                                         ├─▶ (2) Gemini Multimodal 화면 분석
        │                                         │     - 상태 판별 (READY / RECORDING)
        │                                         │     - 원어민 구어체 답변 생성
        │◀─── (3) 마이크 탭 (필요시) ──────────────┤
        │◀─── (4) 고음질 신경망 TTS 음성 출력 ────┤ (PC 스피커 ➡️ 폰 마이크 수음)
        │◀─── (5) 화살표 전송 버튼 탭 ───────────┤
        ▼                                         ▼
   대화 미션 완료! ◀────────────────────────────── 다음 턴 자동 대기
```

1. **초고속 인메모리 화면 캡처 (`src/adbService.js`)**
   - 디스크 파일 저장 없이 `adb exec-out screencap -p` 스트림을 메모리 버퍼(`Buffer.concat`)로 합쳐 즉시 Base64 이미지로 처리합니다.
   - 프로젝트 내 `platform-tools/adb.exe` 또는 시스템 PATH를 자동으로 탐색하여 유연하게 동작합니다.
   - 기기 해상도(예: 1080x2340 등)를 동적으로 읽어와 마이크/전송 버튼의 좌표를 자동 계산합니다.

2. **이중 화면 꺼짐 원천 차단 (`src/adbService.js`)**
   - **타임아웃 연장**: 구동 시 스마트폰의 화면 자동 꺼짐 시간을 **30분(1,800,000ms)**으로 자동 연장합니다. (종료 시 원래 설정으로 복원)
   - **백그라운드 Heartbeat 키퍼**: 1.5초마다 주기적으로 화면 깨우기 및 잠금 해제 신호(`keyevent 224` & `wm dismiss-keyguard`)를 지속 전송하여 폰이 절전/Dozing 모드로 들어가는 것을 방지합니다.

3. **Speak 앱 맞춤형 스마트 발화 시퀀스 (`src/geminiService.js`, `src/index.js`)**
   - **`ALREADY_RECORDING` 모드**: 튜터 발화 완료 후 앱이 이미 "지금 말하세요..."(파란 화살표 전송 버튼) 상태이면 **마이크 탭을 생략하고 즉시 발화**하여 말이 잘리거나 빈 녹음이 전송되는 오류를 원천 차단합니다.
   - **`NEED_MIC_TAP` 모드**: "녹음 버튼을 누르세요" 상태일 때만 **마이크 탭 ➡️ 1,600ms 안정 대기 ➡️ 발화 ➡️ 1,000ms 수음 완료 대기 ➡️ 전송 버튼 탭**의 정밀 시퀀스를 실행합니다.
   - **정체 자동 복구**: 녹음 모드에서 2회 이상 멈출 경우 전송 버튼을 재터치하여 세션을 자동으로 정상화합니다.

4. **멀티 Gemini 모델 풀 & 429 Failover 자동 전환 (`src/geminiService.js`)**
   - Google Free Tier의 일일 한도(RPD) 소진을 극복하기 위해 우선순위 모델 풀(`gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.7-flash`, `gemini-3.8-flash`)을 운영합니다.
   - 특정 모델에서 429(Quota Exceeded)가 발생하면 대기 없이 **즉시 다음 모델로 자동 전환(Failover)**하여 멈춤 없이 대화를 지속합니다.

5. **최신 Microsoft Edge 신경망 TTS (`src/ttsService.js`)**
   - 최신 Microsoft 핸드셰이크 토큰 알고리즘을 지원하는 `@andresaya/edge-tts` 엔진을 채택하여 **403 Forbidden 오류 없이** 자연스러운 원어민 음성(`en-US-JennyNeural`)을 생성합니다.
   - 호출별 인스턴스 격리화로 이전 오류 누적(`voiceLocale undefined`)을 방지하고 자동 재시도 로직을 탑재했습니다.

---

## 📋 필수 사전 준비 사항

### 1. Android 기기 설정
1. 스마트폰의 **설정 > 휴대전화 정보 > 소프트웨어 정보**에서 **'빌드번호'를 7번 연속 탭**하여 개발자 옵션을 활성화합니다.
2. **설정 > 개발자 옵션**에서 **'USB 디버깅'**을 켭니다.
3. PC와 스마트폰을 **데이터 전송이 가능한 USB 케이블**로 연결합니다.
4. 스마트폰 화면에 뜨는 **'USB 디버깅을 허용하시겠습니까?'** 팝업에서 **'이 컴퓨터에서 항상 허용'**에 체크하고 확인을 누릅니다.

### 2. Android SDK Platform-Tools (ADB)
* 본 자동화 프로그램은 안드로이드 제어를 위해 `adb` 실행 파일이 필요합니다.
* **방법 A (권장)**: 구글 공식 [Android Platform-Tools](https://developer.android.com/tools/releases/platform-tools)를 다운로드하여 압축을 푼 뒤, `platform-tools` 폴더 통째로 본 프로젝트 루트(`d:\coding\speak-auto\platform-tools\`)에 넣어두면 자동으로 감지합니다.
* **방법 B**: 시스템 환경 변수(PATH)에 `platform-tools` 경로를 등록해 두어도 자동으로 인식합니다.

### 3. Google Gemini API 키 발급
* [Google AI Studio](https://aistudio.google.com/)에서 무료 API 키를 발급받습니다.

### 4. 스피커 및 마이크 환경
* PC 스피커 소리를 스마트폰 마이크가 수음할 수 있도록, 스마트폰을 PC 스피커 가까이에 두고 볼륨을 적절히 조절합니다.

---

## 🚀 설치 및 실행 가이드

### 1. 저장소 클론 및 패키지 설치
```bash
git clone https://github.com/jjajjara/Speak-App-Conversation-Auto.git
cd Speak-App-Conversation-Auto
npm install
```

### 2. 환경 변수 설정
`.env.example` 파일을 복사하여 `.env` 파일을 생성하고 발급받은 Gemini API 키를 입력합니다:
```bash
copy .env.example .env
```

`.env` 설정 내용:
```env
# Google Gemini API 키 (필수)
GEMINI_API_KEY=AIzaSy...

# 모델 리스트 설정 (우선순위 순서대로 콤마 구분, 429 한도 초과 시 다음 모델로 자동 전환)
GEMINI_MODELS=gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.8-flash

# TTS 보이스 (기본값: en-US-JennyNeural)
TTS_VOICE=en-US-JennyNeural

# 상태 감지 폴링 주기 (밀리초)
POLL_INTERVAL_MS=2000

# 한 턴 발화 후 상대방 응답 대기 시간 (밀리초)
TURN_COOLDOWN_MS=8000
```

### 3. 기기 연결 확인
터미널에서 ADB 기기 연결을 확인합니다:
```bash
# platform-tools 폴더를 프로젝트에 둔 경우
.\platform-tools\adb.exe devices

# 시스템 PATH에 등록된 경우
adb devices
```
> 출력 결과에 기기 번호와 함께 `device`로 표시되어야 합니다. (예: `R3CY10SVJGB device`)

### 4. Speak 앱 실행 및 봇 시작
1. 스마트폰에서 **Speak 앱**을 실행하고 AI 튜터와의 대화 모드(Free Talk 또는 롤플레잉 세션)에 진입합니다.
2. 터미널에서 봇을 시작합니다:
```bash
npm start
```
3. 봇을 종료하려면 언제든지 터미널에서 **`Ctrl + C`**를 누르면 임시 파일 정리와 함께 화면 설정이 원래대로 안전하게 복원됩니다.

---

## 📂 프로젝트 구조

```
Speak-App-Conversation-Auto/
├── platform-tools/         # (선택) Android SDK 플랫폼 도구 (adb.exe)
├── src/
│   ├── config.js           # 환경 변수, 상수 정의 및 유효성 검증
│   ├── adbService.js       # ADB 화면 캡처, 터치, 해상도 감지, 화면 켜짐 유지
│   ├── geminiService.js    # Gemini 3.x Multimodal 분석, 모델 풀 Failover
│   ├── ttsService.js       # MS Edge 고품질 TTS 음성 합성 및 오디오 재생
│   └── index.js            # 메인 오케스트레이터 루프, 콘솔 로깅, 안전 종료
├── .env.example            # 환경 변수 설정 템플릿
├── .gitignore              # 민감 정보(.env) 및 대용량 파일 제외 목록
├── package.json            # Node.js 패키지 설정 (ESM)
└── README.md               # 프로젝트 매뉴얼
```

---

## 📄 라이선스
MIT License

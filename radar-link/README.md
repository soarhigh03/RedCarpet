# Radar Link

ESP32-C5-WROOM-1 이 보내는 레이더 행을 그대로 받아 화면에 그리는 독립 실행 페이지입니다.
이 폴더 하나로 끝나고, 빌드 과정이 없고, 레포의 시뮬레이션 사이트와 코드를 공유하지 않습니다.
(디자인 언어만 따라갑니다 — 네이비 헤더, 민트, 라임 악센트, Pretendard.)

```
radar-link/
├── index.html        화면 구조
├── app.css           사이트와 같은 디자인 토큰
├── js/
│   ├── format.js     mm/도/ms 표기
│   ├── protocol.js   한 줄 파싱 + 기하 계산
│   ├── synthetic.js  보드 없이 쓰는 생성기
│   ├── transports.js BLE / 시리얼 / 브리지
│   ├── scope.js      PPI 캔버스
│   ├── strips.js     시간축 미니 차트
│   └── app.js        상태와 배선
├── sample-log.csv    주신 11줄 (2026-10-11 08:16)
└── bridge.py         pyserial / bleak → WebSocket (선택)
```

## 보는 방법

### 1. 가장 빠른 길 — 그냥 열기

```sh
open radar-link/index.html          # macOS
```

바로 열립니다. `Space` 를 누르면 `sample-log.csv` 가 0.1초에 한 줄씩 재생되고, 왼쪽
**Synthetic feed** 를 누르면 10 Hz 로 새 행이 생성됩니다. `file://` 에서는 샘플 파일을
`fetch` 할 수 없어 내장된 같은 11줄로 대체됩니다.

### 2. 권장 — 레포 루트에서 서빙

Web Bluetooth / Web Serial 로 **실제 보드에 붙으려면** `http://localhost` 가 필요합니다.

```sh
cd /Users/eunvv8/Documents/GitHub/RedCarpet
python3 -m http.server 8080 --bind 127.0.0.1
# → http://127.0.0.1:8080/radar-link/index.html  (Chrome)
```

루트에서 서빙하면 `../public/fonts/PretendardVariable.woff2` 까지 잡혀 타이포까지 사이트와
동일합니다. 폴더 안에서 서빙하면 폰트만 시스템 기본으로 떨어지고 나머지는 같습니다.

### 3. 브라우저가 장치를 막을 때 — 브리지

Safari · Firefox 에는 Web Serial / Web Bluetooth 가 없습니다. 그럴 때 `bridge.py` 가
페이지 서빙과 데이터 전달을 같이 합니다.

```sh
cd radar-link
python3 bridge.py --synthetic                    # 보드 없이, 의존성 없이
python3 bridge.py --file sample-log.csv --loop    # 저장된 로그 재생
python3 bridge.py --serial /dev/cu.usbmodem1101  # pip install pyserial
python3 bridge.py --ble RedCarpet                # pip install bleak
```

띄우면 `http://127.0.0.1:8080/radar-link/index.html` 과 `ws://127.0.0.1:8787` 이 함께
열립니다. 페이지에서 **Python bridge** 를 누르면 붙습니다.

## 칩이 팀원 노트북에 붙어 있을 때

보드는 **수신기 1대만** 받습니다. 그 1대가 팀원 노트북이 되고, 브리지가 받은 줄을 네트워크의
모든 화면으로 뿌립니다. 무선 연결은 하나, 보는 사람은 여러 명.

**팀원 노트북에서** (이 폴더를 복사해 두고, `pip install bleak` 한 번):

```sh
cd radar-link
python3 bridge.py --ble --host 0.0.0.0
```

`--ble` 만 쓰면 기기 이름 `ZYBO-RADAR` 로 찾습니다. 뜨는 주소를 알려주면 됩니다:

```
[bridge] bound to 0.0.0.0: anyone on this network can read the stream and open the page.
[bridge] websocket on ws://192.168.0.235:8787
[bridge] page on http://192.168.0.235:8080/radar-link/index.html
```

**내 노트북에서** — 그 `page on` 주소를 브라우저로 열고 **Python bridge** 를 누릅니다.
페이지가 자기를 띄워준 호스트를 브리지 주소로 기본값으로 잡으니 설정을 건드릴 필요가 없습니다.
받는 쪽에는 아무것도 설치하지 않아도 되고, 브라우저도 Chrome 이 아니어도 됩니다.

주의할 점:

- `--host 0.0.0.0` 은 같은 네트워크의 누구나 스트림과 페이지를 볼 수 있다는 뜻입니다.
  기본값은 `127.0.0.1` 이라 그 노트북 밖으로 나가지 않습니다. 끝나면 브리지를 끄세요.
- macOS 는 처음 실행할 때 들어오는 연결 허용을 묻습니다. 허용해야 LAN 에서 보입니다.
- 둘이 같은 네트워크에 있어야 합니다. 테더링이나 회사 Wi-Fi 의 클라이언트 격리가 걸려 있으면
  팀원 노트북에서 핫스팟을 열고 거기에 붙는 게 가장 빠릅니다.
- 보드를 잠깐 빌릴 수 있다면 브리지 없이 내 Chrome 에서 **Bluetooth LE** 로 바로 붙어도
  됩니다. 단, 팀원 쪽 연결을 먼저 끊어야 합니다.

## 데이터가 들어오는 네 가지 길

| 전송 | 쓰는 경우 | 필요 조건 |
|---|---|---|
| **Bluetooth LE** | `ZYBO-RADAR` 에 직접 연결. Nordic UART notify 구독 | Chrome + `http://localhost` |
| **Serial port** | USB 케이블(CDC) 또는 가상 COM 포트, 기본 115200 | Chrome + `http://localhost` |
| **Python bridge** | 보드가 다른 노트북에 붙어 있거나 브라우저가 막을 때 | `bridge.py` 실행 |
| **Replay / Synthetic** | 보드 없이 개발 | 없음 |

보드 BLE 제원:

| 항목 | 값 |
|---|---|
| 기기 이름 | `ZYBO-RADAR` |
| 서비스 UUID | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` (Nordic UART Service) |
| Notify 특성 | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |
| 데이터 모양 | ASCII 20바이트씩. 조각을 이어 붙여 `\n` 에서 한 줄 |
| 속도 | 초당 10줄 |
| 동시 연결 | 1대 |

> **BLE 전용**이라 OS 블루투스 설정에서 페어링하지 않습니다. 페이지가 직접 연결하므로
> 페어링으로 생기는 `/dev/cu.*` 포트는 없습니다. 20바이트 조각 재조립은 BLE·시리얼·브리지
> 세 경로 모두에서 같은 라인 버퍼가 처리합니다. UUID 와 기기 필터는 설정에서 바꿀 수 있습니다.

## 화면에 있는 것

**스코프** — 레이더가 원점, 정면(x)이 위, 방위 + 쪽이 오른쪽(설정에서 반대로 가능).
표시되는 건 모두 보드가 보낸 값입니다.

- 접촉 위치: 거리·방위 그대로. cls 2 는 쿼드 글리프(주황), cls 1 은 원(강청).
- **가야 할 속도 벡터**: 원점에서 나가는 라임색 화살. `sol=1` 이면 요격 지점까지 그려지므로
  화살 길이가 곧 `속도 × 요격까지` 입니다. `sol=0` 이면 길이를 고정한 점선(황토색)으로
  바뀌고 `chase · no solution` 이라고 붙습니다.
- 요격 지점: 민트 다이아몬드. 접촉에서 그 지점까지 점선이 연결됩니다.
- 궤적: 최근 몇 초(설정값)의 잔상.
- 바깥 호가 프레임이 들어올 때마다 라임색으로 밝아집니다. 이 센서는 FMCW 라 회전부가
  없으므로 돌아가는 스윕은 그리지 않습니다 — 링크 상태를 알리는 UI 신호입니다.

**상단 HUD** — 거리 / 방위 / 접근속도 / 요격까지 / 커맨드 / 프레임 레이트.
접근속도는 `+` 가 가까워짐이라 부제목에 `closing`·`opening` 을 같이 적습니다.

**Link 패널** — 프레임 수, 레이트, 유실, 표적 없는 프레임 수, 못 읽은 줄, 수신량.
프레임 번호가 건너뛰면 유실로 셉니다(16비트 랩어라운드 처리, 500 이상 튀면 resync).

**Contact 패널** — 선택된 접촉의 전체 값과 **Solution check**:

| 행 | 내용 |
|---|---|
| Commanded speed | `hypot(가야할속도x, y)`. 설정 속력과 2% 넘게 다르면 경고 |
| Vector heading | `atan2(y, x)` |
| Reported heading | 보드가 보낸 보정방향, 위와의 차이 |
| Intercept range | `속도 × 요격까지` = 요격 지점까지 거리 |
| Radial prediction | `거리 − 접근속도 × 요격까지` |
| Agreement | 두 값의 차. 접근속도가 요격 시간 내내 일정하다는 가정이라 수 mm 차이는 정상 |

주신 11줄은 전부 1.5–2.3 mm 로 맞습니다. 즉 그 데이터는 자기 자신과 일관됩니다.

**Stream** — 들어온 원본 줄 그대로. 형식에 맞지 않는 줄은 **Problems** 탭으로 이유와 함께
분리됩니다. `Export log` 로 받은 전부를 `.csv` 로 저장합니다(최대 5만 줄).

여기서는 보드 값을 보정하지 않습니다. 스스로 모순된 행은 모순된 채로 보이고, 링크가 흘린
프레임은 메워지지 않고 세어집니다.

## 와이어 형식

```
G,frame,idx,cls,sol,거리mm,방위(0.01°),접근속도mm/s,요격까지ms,가야할속도x,가야할속도y,보정x,보정y,보정방향(0.01°)
G,frame,-1        ← 이 프레임에 표적 없음
```

- 트랙은 `idx` 로 구분됩니다. 한 프레임에 여러 행이 와도 됩니다.
- `#` 로 시작하는 줄은 로그 주석으로 무시합니다.
- 14개도 3개도 아닌 `G` 행, 정수가 아닌 필드는 Problems 에 이유가 남습니다.
- 그 외 줄(부팅 로그 등)은 `other` 로 분류되고 파싱을 막지 않습니다.

## 단축키

`Space` 재생/정지 · `→` 한 줄 · `R` 처음으로 · `A` 자동 거리 · `1`–`9` 트랙 선택 · `Esc` 자동 선택

## 설정

톱니바퀴에서: 거리(자동/고정), 시야각, 방위 + 방향, 잔상 길이, 트랙 유지 시간, 설정 속력,
히스토리 창, 시리얼 보드레이트, 브리지 URL, BLE UUID, 재생 간격. 브라우저에만 저장됩니다.
스코프에서 스크롤하면 거리가 고정 모드로 바뀌며 조절됩니다.

## 주의

`synthetic.js` / `bridge.py --synthetic` 의 궤적은 직선 등속 + 닫힌 형태 교차해의 **교육용
모델**이고, 유도나 사격통제 모델이 아닙니다. 화면과 로그에 항상 synthetic 으로 표시됩니다.

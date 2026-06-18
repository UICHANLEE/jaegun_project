import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "outputs/preparation";

const materials = [
  ["운영", "관리자용 노트북/태블릿", "관리자 페이지", 1, "대여/준비", "http://localhost:8123/index.html 접속. 힌트 오픈 현황과 정답 확인용.", "상", "", "운영자 1명 전담"],
  ["운영", "참가자용 QR 안내지", "참가자 페이지", "팀별 1장", "인쇄", "http://localhost:8123/player.html 주소를 QR로 제작. 입장 시 팀별 배포.", "상", "", "휴대폰 화면 기준"],
  ["운영", "힌트코드 카드 또는 봉투", "힌트 16개", "16장", "인쇄/재단", "각 힌트코드를 별도 카드로 제작. 현장 문제를 풀어 얻도록 배치.", "상", "", "코드는 참가자에게 한 번에 공개하지 않기"],
  ["운영", "정답 봉투", "최종 추리", 1, "인쇄/봉투", "모든 힌트 확인 후 열 수 있는 최종 정답지. 범인: 홍강도.", "상", "", "관리자 보관"],
  ["운영", "용의자 프로필 카드", "홍강도, 이비리, 서신자, 박간호", "4장", "인쇄", "직업/나이/성별만 표시. 웹페이지 프로필과 동일하게 제작.", "중", "", "인물 사진 포함 가능"],
  ["운영", "교회 사건 현장 세팅", "전체 분위기", 1, "현장 세팅", "목양실 책상, 십자가, 성경책, 어두운 조명, 사건 현장 테이프/표지.", "상", "", "교회에서 해도 과하지 않게 정돈"],
  ["운영", "필기구와 추리 기록지", "참가자 진행", "팀별 1세트", "구매/인쇄", "단서 기록용 종이, 볼펜, 클립보드.", "중", "", "힌트코드 메모 공간 포함"],
  ["운영", "스피커 또는 QR 오디오 안내", "오디오 힌트 5개", 1, "준비", "녹취/음성 힌트를 재생할 장치. QR 방식이면 휴대폰 재생 가능.", "상", "", "소리가 너무 커서 예배 공간을 방해하지 않게 조절"],

  ["홍강도", "목사님 이름 라벨이 붙은 알러지 약", "힌트1: 목사님 이름이 적힌 알러지 약", 1, "소품 제작", "작은 약통 또는 약봉투에 목사님 이름 라벨 부착. 알러지 약처럼 보이게 연출.", "상", "", "실제 의약품 사용 주의"],
  ["홍강도", "땅콩가루 소분 봉투", "힌트2: 땅콩가루", 1, "소품 제작", "땅콩가루처럼 보이는 안전한 분말을 투명 지퍼백에 소량 담기.", "상", "", "알러지 위험이 있으면 콩가루/미숫가루 등 대체"],
  ["홍강도", "사례비 대화 녹취 파일", "힌트3: 사례비 대화 녹취", 1, "오디오 제작", "홍강도가 사례 인상을 요청하고 목사님에게 핀잔을 듣는 짧은 대화.", "상", "", "REC-1012 라벨"],
  ["홍강도", "찬양팀 연습 소리 녹음", "힌트4: 찬양팀 연습 소리", 1, "오디오 제작", "사망추정시각 알리바이처럼 보이는 찬양팀 연습 BGM.", "중", "", "알리바이 확인용"],

  ["이비리", "복도에서 화내는 음성", "힌트1: 화내는 음성", 1, "오디오 제작", "비리 폭로를 암시하는 격한 말투의 짧은 음성.", "상", "", "09:57 녹음 라벨"],
  ["이비리", "얼룩진 구겨진 돈", "힌트2: 얼룩진 구겨진 돈", "여러 장", "소품 제작", "모형 지폐를 구겨서 축축한 얼룩 표현. 봉투 B-04에 보관.", "중", "", "실제 지폐 훼손 금지"],
  ["이비리", "회계장부 사본", "힌트3: 회계장부", 1, "인쇄", "수상한 지출 내역과 표시가 있는 재정부 장부 사본.", "상", "", "비리 의심용 가짜 장부"],
  ["이비리", "식사 당번 체크표", "힌트4: 식사 당번 체크표", 1, "인쇄", "사망추정시각 식사 당번 알리바이를 확인하는 체크표.", "중", "", "주방 봉사자 체크표 라벨"],

  ["서신자", "신만지 교회 단톡방 캡처", "힌트1: 신만지 교회 단톡방 캡처", 1, "이미지/인쇄", "서신자가 이름을 숨기고 들어왔다는 정황을 담은 단톡방 캡처.", "상", "", "개인정보처럼 보이는 실제 정보 사용 금지"],
  ["서신자", "신분증 소품", "힌트2: 신분증", 1, "소품 제작", "신만지 교회 소속, 본명 서만희가 보이는 가상 신분증.", "상", "", "여성 인물 설정 반영"],
  ["서신자", "청년들과 목사님의 카톡 캡처", "힌트3: 청년들과 목사님의 카톡", 1, "이미지/인쇄", "다른 청년들과 목사님의 대화로 서신자 정체를 의심하게 하는 자료.", "상", "", "목사님 휴대폰 백업 라벨"],
  ["서신자", "복도 동선 스티커/보드", "힌트4: 복도 동선 스티커", 1, "인쇄/부착", "화장실 이동 중 목양실 큰 소리를 들었다는 동선을 시각화.", "중", "", "CCTV 대체 보드처럼 연출"],

  ["박간호", "혼잣말 녹음 파일", "힌트1: 혼잣말 녹음", 1, "오디오 제작", "찬양소리 때문에 잠을 못 자 짜증내는 혼잣말. 배경에 찬양 BGM.", "상", "", "휴대폰 음성 메모 10:08"],
  ["박간호", "10시 10분 친구와의 카톡", "힌트2: 10시 10분 친구와의 카톡", 1, "이미지/인쇄", "사망추정시각 근처에 친구와 대화했다는 카톡 캡처.", "상", "", "알리바이 보강용"],
  ["박간호", "하루견과 봉지", "힌트3: 하루견과", 1, "소품 구매", "간호사의 소지품처럼 놓을 하루견과 봉지.", "중", "", "땅콩 알러지 단서와 연결"],
  ["박간호", "최초 발견 신고 기록", "힌트4: 최초 발견 신고 기록", 1, "인쇄", "교회 단체방에 목사님 발견 사실을 알린 메시지 기록.", "중", "", "최초 발견자 확인"],

  ["출력물", "힌트 이미지 4종", "웹페이지 증거 이미지", "각 1장", "인쇄", "알러지/재정/새신자/간호사 증거 대표 이미지. 웹 assets 폴더 파일 사용.", "중", "", "필요 시 A5 사이즈"],
  ["출력물", "가상 인물 사진 4종", "용의자 이미지", "각 1장", "인쇄", "홍강도, 이비리, 서신자, 박간호 가상 프로필 이미지.", "중", "", "웹 assets 폴더 파일 사용"],
  ["출력물", "힌트코드 관리자표", "운영자용", 1, "인쇄", "각 인물별 힌트1~4 코드와 제목을 한눈에 보는 운영자용 표.", "상", "", "참가자에게 노출 금지"],
];

const codes = [
  ["홍강도", "힌트1", "SILOAM73", "목사님 이름이 적힌 알러지 약"],
  ["홍강도", "힌트2", "KAIROS18", "땅콩가루"],
  ["홍강도", "힌트3", "MARAH52", "사례비 대화 녹취"],
  ["홍강도", "힌트4", "SELAH09", "찬양팀 연습 소리"],
  ["이비리", "힌트1", "EBEN47", "화내는 음성"],
  ["이비리", "힌트2", "TITHE68", "얼룩진 구겨진 돈"],
  ["이비리", "힌트3", "LEDGER31", "회계장부"],
  ["이비리", "힌트4", "BASIN94", "식사 당번 체크표"],
  ["서신자", "힌트1", "DAMAS12", "신만지 교회 단톡방 캡처"],
  ["서신자", "힌트2", "TALITHA86", "신분증"],
  ["서신자", "힌트3", "GALIL27", "청년들과 목사님의 카톡"],
  ["서신자", "힌트4", "NARDO45", "복도 동선 스티커"],
  ["박간호", "힌트1", "SHALOM64", "혼잣말 녹음"],
  ["박간호", "힌트2", "RHEMA20", "10시 10분 친구와의 카톡"],
  ["박간호", "힌트3", "MANNA57", "하루견과"],
  ["박간호", "힌트4", "WATCH38", "최초 발견 신고 기록"],
];

const workbook = Workbook.create();
const prepSheet = workbook.worksheets.add("준비물");
const codeSheet = workbook.worksheets.add("힌트코드");
const summarySheet = workbook.worksheets.add("요약");

const headerStyle = {
  fill: "#243B53",
  font: { bold: true, color: "#FFFFFF" },
  wrapText: true,
};

summarySheet.getRange("A1:H1").merge();
summarySheet.getRange("A1").values = [["교회 방탈출 준비 요약"]];
summarySheet.getRange("A1").format = {
  fill: "#6B2D2D",
  font: { bold: true, color: "#FFFFFF", size: 16 },
};
summarySheet.getRange("A3:B8").values = [
  ["총 준비 항목", materials.length],
  ["오디오 제작", materials.filter((row) => row[4] === "오디오 제작").length],
  ["소품 제작/구매", materials.filter((row) => String(row[4]).includes("소품") || String(row[4]).includes("구매")).length],
  ["인쇄/이미지 출력", materials.filter((row) => String(row[4]).includes("인쇄") || String(row[4]).includes("이미지")).length],
  ["상 우선순위", materials.filter((row) => row[6] === "상").length],
  ["힌트코드 수", codes.length],
];
summarySheet.getRange("A3:A8").format = { font: { bold: true }, fill: "#E7EEF7" };
summarySheet.getRange("A3:B8").format.borders = { preset: "all", style: "thin", color: "#B7C7D9" };
summarySheet.getRange("D3:H7").values = [
  ["운영 메모", "", "", "", ""],
  ["1", "실물 힌트는 참가자가 만져도 되는 안전한 대체품으로 준비합니다.", "", "", ""],
  ["2", "힌트코드는 운영자표 외에는 한 번에 노출하지 않습니다.", "", "", ""],
  ["3", "오디오 힌트는 QR 또는 관리자 재생 방식 중 하나로 통일합니다.", "", "", ""],
  ["4", "구글시트에 가져갈 때는 첫 행을 헤더로 고정하면 운영하기 편합니다.", "", "", ""],
];
summarySheet.getRange("D3:H3").merge();
summarySheet.getRange("D3").format = headerStyle;
summarySheet.getRange("E4:H7").merge(true);
summarySheet.getRange("D4:H7").format.borders = { preset: "all", style: "thin", color: "#D9E2EC" };
summarySheet.getRange("D4:D7").format = { fill: "#F8FAFC", font: { bold: true } };

prepSheet.getRange("A1:I1").values = [[
  "구분",
  "준비물",
  "관련 힌트/용도",
  "수량",
  "준비 방식",
  "세부 내용",
  "우선순위",
  "상태",
  "비고",
]];
prepSheet.getRangeByIndexes(1, 0, materials.length, 9).values = materials;
prepSheet.getRange("A1:I1").format = headerStyle;
prepSheet.getRangeByIndexes(0, 0, materials.length + 1, 9).format.borders = {
  preset: "all",
  style: "thin",
  color: "#D9E2EC",
};
prepSheet.getRangeByIndexes(1, 7, materials.length, 1).dataValidation = {
  rule: { type: "list", values: ["미정", "준비중", "완료"] },
};
prepSheet.getRangeByIndexes(1, 6, materials.length, 1).conditionalFormats.add("containsText", {
  text: "상",
  format: { fill: "#FCE7E7", font: { bold: true, color: "#9B1C1C" } },
});
prepSheet.getRangeByIndexes(1, 0, materials.length, 1).format = { fill: "#F8FAFC", font: { bold: true } };
prepSheet.getRangeByIndexes(0, 0, materials.length + 1, 9).format.wrapText = true;
prepSheet.freezePanes.freezeRows(1);

codeSheet.getRange("A1:D1").values = [["인물", "힌트", "힌트코드", "힌트 제목"]];
codeSheet.getRangeByIndexes(1, 0, codes.length, 4).values = codes;
codeSheet.getRange("A1:D1").format = headerStyle;
codeSheet.getRangeByIndexes(0, 0, codes.length + 1, 4).format.borders = {
  preset: "all",
  style: "thin",
  color: "#D9E2EC",
};
codeSheet.getRangeByIndexes(1, 2, codes.length, 1).format = {
  font: { bold: true, color: "#7C2D12" },
  fill: "#FFF7ED",
};
codeSheet.freezePanes.freezeRows(1);

for (const sheet of [summarySheet, prepSheet, codeSheet]) {
  sheet.showGridLines = false;
}

summarySheet.getRange("A:H").format.columnWidthPx = 130;
summarySheet.getRange("D:H").format.columnWidthPx = 160;
prepSheet.getRange("A:A").format.columnWidthPx = 90;
prepSheet.getRange("B:B").format.columnWidthPx = 180;
prepSheet.getRange("C:C").format.columnWidthPx = 190;
prepSheet.getRange("D:D").format.columnWidthPx = 90;
prepSheet.getRange("E:E").format.columnWidthPx = 120;
prepSheet.getRange("F:F").format.columnWidthPx = 360;
prepSheet.getRange("G:I").format.columnWidthPx = 100;
codeSheet.getRange("A:A").format.columnWidthPx = 100;
codeSheet.getRange("B:B").format.columnWidthPx = 80;
codeSheet.getRange("C:C").format.columnWidthPx = 110;
codeSheet.getRange("D:D").format.columnWidthPx = 240;

await fs.mkdir(outputDir, { recursive: true });

const preview = await workbook.render({
  sheetName: "준비물",
  range: "A1:I28",
  scale: 1,
  format: "png",
});
await fs.writeFile(`${outputDir}/preparation-preview.png`, new Uint8Array(await preview.arrayBuffer()));

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(`${outputDir}/church_escape_preparation.xlsx`);

const tsvRows = [
  ["구분", "준비물", "관련 힌트/용도", "수량", "준비 방식", "세부 내용", "우선순위", "상태", "비고"],
  ...materials,
];
await fs.writeFile(
  `${outputDir}/church_escape_preparation.tsv`,
  tsvRows.map((row) => row.map((cell) => String(cell).replaceAll("\t", " ")).join("\t")).join("\n"),
  "utf8",
);

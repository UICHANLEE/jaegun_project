import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("outputs/preparation/church_escape_preparation.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);

const overview = await workbook.inspect({
  kind: "sheet,table",
  maxChars: 3000,
  tableMaxRows: 6,
  tableMaxCols: 8,
});
console.log(overview.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "formula error scan",
});
console.log(errors.ndjson);

for (const sheetName of ["요약", "준비물", "힌트코드"]) {
  const preview = await workbook.render({
    sheetName,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  await fs.writeFile(
    `outputs/preparation/${sheetName}-preview.png`,
    new Uint8Array(await preview.arrayBuffer()),
  );
}

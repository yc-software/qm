export const recallText = (rows: ReadonlyArray<{ text: string }>) => rows.map((row) => row.text).join("\n");

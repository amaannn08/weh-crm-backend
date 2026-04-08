import { sheetQueryTool } from './services/tools/sheetQueryTool.js';
async function main() {
  const result = await sheetQueryTool.execute({ input: { query: "inbounds in march" } });
  console.log("Total chars:", result.sheetContext.length);
  const lines = result.sheetContext.split('\n').filter(l => l.startsWith('Timestamp:'));
  console.log("Rows returned:", lines.length);
  console.log("First 3:", lines.slice(0, 3).join('\n'));
  console.log("Last 3:", lines.slice(-3).join('\n'));
}
main();

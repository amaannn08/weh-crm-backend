import { sheetQueryTool } from './services/tools/sheetQueryTool.js';

async function main() {
  const result = await sheetQueryTool.execute({ input: { query: "outbounds", tab: "Outbound Contacts" } });
  console.log(result.sheetContext.substring(0, 1000));
}
main();

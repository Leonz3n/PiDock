// Actual OS system-browser handoff, using only a synthetic loopback account.
import { app, shell } from "electron";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oauthFixture } from "./fixtures/mcp-oauth-server.mjs";
import { McpOAuth } from "../dist/main/mcp-oauth.js";
import { NativeMcpFile } from "../dist/main/native-mcp-config.js";
import { createTestSafeStorage } from "../dist/main/provider-secret-store.js";
async function run() {
const root = mkdtempSync(join(tmpdir(), "pidock-oauth-browser-"));
app.setPath("userData", root);
await app.whenReady();
const server = await oauthFixture();
writeFileSync(join(root,"mcp.json"),JSON.stringify({mcpServers:{browser_smoke:{url:`${server.base}/mcp`,oauth:{clientRegistration:"dcr"}}}}));
let launches=0;
const oauth=await McpOAuth.create(new NativeMcpFile(root),root,createTestSafeStorage(),async url=>{launches++;await shell.openExternal(url);});
let passed=false;
try {
  await oauth.start("browser_smoke");
  for(let i=0;i<150;i++) { if((await oauth.status("browser_smoke")).state === "signed-in") { passed=true;break; } await new Promise(done=>setTimeout(done,100)); }
  console.log(JSON.stringify({passed:passed && launches===1,systemBrowserLaunches:launches,upstreamTokenExchanges:server.requests.filter(request=>request.kind === "token").length,state:(await oauth.status("browser_smoke")).state,node:process.versions.node,electron:process.versions.electron,storage:"deterministic AES fixture, no OS keychain claim"}));
} finally { await oauth.close();await server.close();rmSync(root,{recursive:true,force:true});app.exit(passed?0:1); }

}
void run().catch(error=>{console.error(error.message);app.exit(1);});

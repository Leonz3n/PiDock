// Deterministic private authorization/MCP server. It drives Pi's actual OAuth.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
export async function oauthFixture() {
  let mode = 'success', base, expectedSecret, lifetime=3600, challengeOnly=false, requiredScope='';
  const registrations = [], requests = [], codes = new Map();
  let token = 0;
  const tokens = new Map();
  const endpoint = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, base), json = (data, status = 200) => res.writeHead(status, { 'content-type':'application/json' }).end(JSON.stringify(data));
    if (url.pathname === '/private-resource-metadata' || (!challengeOnly && (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource'))) return json({resource:`${base}/mcp`,authorization_servers:[challengeOnly ? `${base}/private-auth` : base]});
    if (url.pathname === '/.well-known/oauth-authorization-server/private-auth' || (!challengeOnly && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration'))) return json({issuer:challengeOnly ? `${base}/private-auth` : base,authorization_endpoint: mode === 'unsafe' ? 'file:///tmp/private-oauth' : `${base}/authorize`,token_endpoint:`${base}/token`,registration_endpoint:`${base}/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none','client_secret_basic','client_secret_post'],client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true});
    if (url.pathname === '/register') { const data=JSON.parse(body); registrations.push(data); return json({client_id:'fixture-client',...data},201); }
    if (url.pathname === '/authorize') {
      requests.push({kind:'authorize',clientId:url.searchParams.get('client_id'),scope:url.searchParams.get('scope')});
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', mode === 'mismatch' ? 'wrong-state' : url.searchParams.get('state'));
      callback.searchParams.set('iss',challengeOnly ? `${base}/private-auth` : base);
      if (mode === 'failure') callback.searchParams.set('error','access_denied');
      else { const code=`private-code-${codes.size}`; codes.set(code,{challenge:url.searchParams.get('code_challenge'),scope:url.searchParams.get('scope') ?? ''}); callback.searchParams.set('code',code); }
      res.writeHead(302,{location:callback.href}).end(); return;
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body); let scope='';
      if (expectedSecret && params.get('client_secret') !== expectedSecret && !Buffer.from((req.headers.authorization ?? '').replace(/^Basic /,''),'base64').toString().endsWith(':'+expectedSecret)) return json({error:'invalid_client'},401);
      if (params.get('grant_type') === 'authorization_code') {
        const expected=codes.get(params.get('code'));
        const actual=createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
        if (!expected || expected.challenge !== actual) return json({error:'invalid_grant'},400);
        scope=expected.scope; codes.delete(params.get('code'));
      }
      const access=`private-access-${++token}`; tokens.set(access,scope); requests.push({kind:'token',grant:params.get('grant_type')});
      return json({access_token:access,token_type:'Bearer',refresh_token:`private-refresh-${token}`,expires_in:lifetime,scope});
    }
    if (url.pathname === '/mcp') {
      const granted=tokens.get((req.headers.authorization ?? '').replace(/^Bearer /,''));
      if (granted === undefined || (requiredScope && !granted.split(/\s+/).includes(requiredScope))) return res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${base}/${challengeOnly ? 'private-resource-metadata' : '.well-known/oauth-protected-resource'}"${granted !== undefined && requiredScope ? `, error="insufficient_scope", scope="${requiredScope}"` : ''}`}).end();
      const rpc=body ? JSON.parse(body):{};
      requests.push({kind:'mcp',method:rpc.method});
      if (req.method === 'DELETE') return res.writeHead(200).end();
      if (!rpc.id) return res.writeHead(202).end();
      const result=rpc.method === 'initialize' ? {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'oauth-fixture',version:'1'}} : rpc.method === 'tools/list' ? {tools:[{name:'echo',description:'Authenticated echo',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']}}]} : rpc.method === 'tools/call' ? {content:[{type:'text',text:`OAuth echo: ${rpc.params.arguments.message}`}]} : {};
      return json({jsonrpc:'2.0',id:rpc.id,result});
    }
    res.writeHead(404).end();
  });
  await new Promise(done=>endpoint.listen(0,'127.0.0.1',()=>done(undefined))); base=`http://127.0.0.1:${(/** @type {import("node:net").AddressInfo} */ (endpoint.address())).port}`;
  return { base, registrations, requests, challengeOnly:value=>{challengeOnly=value;}, requireScope:value=>{requiredScope=value;}, expires:seconds=>{lifetime=seconds;}, requireSecret:value=>{expectedSecret=value;}, mode: value=>{mode=value;}, revoke:()=>tokens.clear(), close:()=>new Promise(done=>{endpoint.close(done);endpoint.closeAllConnections();}) };
}

/**
 * Stable remote identity for [PiDock 03] (#6) source binding, shared by task
 * creation (which pins it) and the Host facts read (which re-verifies it on
 * open). The digest is of the *transport* spelling only: userinfo and
 * credentials are refused, so a digest never carries a secret and two
 * different remotes cannot collide by accident.
 */
import { createHash } from "node:crypto";

export function remoteDigest(url: string): string {
  if (/^(?:ext::|[^:/]+::|-)/i.test(url) || /[\r\n\0]/.test(url)) throw new Error("不支持的远程传输方式");
  let transport: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("不支持的远程传输方式");
    }
    if (!["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol)) throw new Error("不支持的远程传输方式");
    if (url.includes("?") || url.includes("#")) throw new Error("远程地址含查询或片段参数，无法固定来源身份");
    const authority = url.match(/^[^:]+:\/\/([^/?#]*)/)?.[1] ?? "";
    const userinfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : "";
    // SSH account names select a remote identity; HTTP userinfo and encoded/colon SSH userinfo may carry secrets.
    if ((parsed.protocol !== "ssh:" && userinfo) || /[:%]/.test(userinfo) || parsed.password) {
      throw new Error("远程地址含凭据，无法安全固定来源身份");
    }
    // URL serialization removes dot segments before Git resolves symlinked path components.
    transport = url;
  } else if (/^(?:[^@:]+@)?[^/:]+:.+/.test(url) && !/^[a-z]:[\\/]/i.test(url)) {
    if (/[?#]/.test(url)) throw new Error("远程地址含查询或片段参数，无法固定来源身份");
    const account = url.match(/^([^@:]+)@[^/:]+:.+/)?.[1];
    if (account?.includes("%")) throw new Error("远程地址含凭据，无法安全固定来源身份");
    transport = url;
  } else transport = url;
  return createHash("sha256").update(transport).digest("hex");
}

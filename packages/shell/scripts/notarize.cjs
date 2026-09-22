const { notarize } = require("@electron/notarize");

/**
 * electron-builder afterSign hook.
 *
 * Signing/notarisation are skipped unless Apple credentials are provided, so
 * the same config produces unsigned packaging candidates in CI without secrets.
 * Required environment for a signed + notarised release build:
 *   CSC_LINK / CSC_KEY_PASSWORD  (Developer ID Application certificate)
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 */
module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  const appName = context.packager.appInfo.productFilename;

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      "[notarize] skipped: set APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID to notarise",
    );
    return;
  }

  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
};

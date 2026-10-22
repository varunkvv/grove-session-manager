// signs the app again with the release certificate, after electron-builder's ad-hoc pass and
// before the dmg is made. macOS keeps a screen recording or microphone grant only while the app
// matches the signature it was granted to. an ad-hoc signature is matched by its hash, which every
// build changes, so each update dropped the grant while its switch still showed on. a certificate's
// is matched by the certificate, the same in every release.
//
// electron-builder only signs with a certificate macOS trusts, and this one is self-signed. CSC_LINK
// still has it put the certificate in a keychain for the build, where codesign finds it by name.
// with no GROVE_SIGN_IDENTITY this does nothing, so a local build stays ad-hoc. the outer bundle is
// the one macOS checks, so the helpers inside keep their ad-hoc signatures
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterSign(context) {
  const identity = process.env.GROVE_SIGN_IDENTITY;
  if (!identity || context.electronPlatformName !== "darwin") return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • afterSign: signing ${app} with "${identity}"`);
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      identity,
      // apple's timestamp server only stamps apple's own certificates
      "--timestamp=none",
      "--preserve-metadata=entitlements,flags",
      app,
    ],
    { stdio: "inherit" },
  );
};

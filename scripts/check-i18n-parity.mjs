/**
 * Quick en/zh dictionary parity check.
 * Run: node --input-type=module scripts/check-i18n-parity.mjs
 * (from src/picot)
 */
import en from "../public/i18n/en.js";
import zh from "../public/i18n/zh.js";

const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
const onlyEn = enKeys.filter((k) => !(k in zh));
const onlyZh = zhKeys.filter((k) => !(k in en));
const equal =
  enKeys.length === zhKeys.length && onlyEn.length === 0 && onlyZh.length === 0;

console.log(
  JSON.stringify(
    {
      en: enKeys.length,
      zh: zhKeys.length,
      onlyEn,
      onlyZh,
      equal,
    },
    null,
    2,
  ),
);

if (!equal) process.exit(1);

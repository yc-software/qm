import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function adminDictionary(): Record<string, string> {
  const body = html.match(/const ADMIN_ZH = \{([\s\S]*?)\n {6}\};\n {6}const normalizeAdminLocale/)?.[1];
  assert.ok(body);
  return new Function(`return ({${body}});`)() as Record<string, string>;
}

test("admin and web surfaces share one persisted locale", () => {
  assert.match(html, /const ADMIN_LOCALE_KEY = "qm:locale";/);
  assert.match(html, /localStorage\.getItem\(ADMIN_LOCALE_KEY\)/);
  assert.match(html, /localStorage\.setItem\(ADMIN_LOCALE_KEY, adminLocale === "en" \? "zh-CN" : "en"\)/);
  assert.match(html, /document\.documentElement\.lang = adminLocale;/);
});

test("admin exposes a bilingual control and translates only explicit UI sinks", () => {
  assert.match(html, /id="locale-toggle" type="button" data-i18n-skip>中文<\/button/);
  assert.match(html, /const ADMIN_ZH = \{/);
  assert.match(html, /Governance: "治理"/);
  assert.match(html, /Sessions: "会话"/);
  assert.doesNotMatch(html, /new MutationObserver/);
  assert.match(html, /translateAdminNode\(document\.body\);/);
  assert.match(html, /b\.textContent = adminTr\(cell\.action\.label\)/);
  assert.match(html, /heading\.textContent = adminTr\("Version history"\)/);
  assert.match(html, /edit\.textContent = adminTr\("Edit destination"\)/);
  assert.match(html, /loading\.textContent = adminTr\("Loading Slack mirror\.\.\."\)/);
  assert.match(html, /msgTitle\.textContent = adminTr\("Message"\)/);
  assert.match(html, /el\.textContent = adminTr\(text\)/);
  assert.match(html, /scopes\.textContent = adminTr\(/);
  assert.match(html, /item\.textContent = adminTr\(text\)/);
  assert.match(html, /\? adminTr\("Today"\)/);
  assert.match(html, /s\.textContent = adminTr\(text\)/);
  assert.match(html, /b\.textContent = adminTr\(it\.label\)/);
  assert.match(html, /btn\.setAttribute\("aria-label", adminTr\("Actions"\)\)/);
  assert.match(html, /b\.textContent = adminTr\(label\)/);
  assert.match(html, /adminTr\(activeRows\.length \+ \(activeRows\.length === 1/);
  assert.match(html, /document\.title = `\$\{brandSelfLabel\(\)\} \$\{adminTr\("Admin"\)\}`/);
  assert.match(html, /adminTr\(Number\(background\)\.toLocaleString\(adminLocaleCode\(\)\) \+ " background"\)/);
  assert.match(html, /card\.title = adminTr\(expanded \? "Click to collapse tool text"/);
  assert.match(html, /link\.title = adminTr\(/);
  assert.match(html, /label\.textContent = adminTr\(deliveryLabel\)/);
  assert.match(html, /`\$\{adminTr\(deliveryState\)\} · \$\{fmtTime\(event\.createdAt\)\}`/);
  assert.match(html, /\$\("sc-cap-state"\)\.textContent = adminTr\(/);
  assert.match(html, /adminTr\("Any path on this host"\)/);
  assert.match(html, /\$\("sc-cap-secret"\)\.textContent = adminTr\(secretStatus\)/);
  assert.match(html, /response\.data\?\.message \|\| adminTr\("Simulation failed\."\)/);
  assert.match(html, /adminTr\("No scope-policy rule matches"\)/);
  assert.match(html, /adminTr\("last sync:"\)/);
  assert.match(html, /adminTr\("available \(eligible\) in this pack"\)/);
  assert.match(html, /adminTr\("logged in this scope"\)/);
  assert.match(html, /btn\(adminTr\("← Prev"\)/);
  assert.match(html, /function setApiStatus\(id, serverMessage, fallback, kind, sticky = false\)/);
  assert.match(html, /setStatus\(id, serverMessage \|\| fallback, kind, sticky, !serverMessage\)/);
  assert.match(html, /adminTr\("contains invalid host"\)/);
  assert.match(html, /adminTr\("appears in both lists\. Remove it from one list before saving\."\)/);
  assert.match(html, /b\.textContent = adminTr\(text\)/);
  assert.match(html, /status\.textContent = r2\.data\?\.message \|\| adminTr\("Import failed"\)/);
  assert.match(html, /plural\(added, "skill"\)/);
  assert.match(html, /label: adminTr\("System prompt"\)/);
  assert.match(html, /label: adminTr\("Tool schemas"\)/);
  assert.match(html, /metaChip\(adminTr\("cache"\)/);
  assert.match(html, /lbl\.textContent = adminTr\(label\) \+ " "/);
  assert.match(html, /a\.textContent = adminTr\(label\)/);
  assert.match(html, /badge\(pillCount\(key\) \+ " " \+ adminTr\(meta\.label\)/);
  assert.match(html, /adminTr\("Click to show only these\."\)/);
  assert.match(html, /adminTr\(bundlePaths\.length === 1 \? "shared pack file" : "shared pack files"\)/);
  assert.match(html, /adminTr\(open \? "Collapse entry" : "Expand entry"\)/);
  assert.match(html, /adminTr\(open \? "Collapse model context" : "Expand model context"\)/);
  assert.match(html, /text\.appendChild\(slackParseText\(m\.text \|\| "", m\.mentions\)\)/);
  assert.match(html, /txt\.textContent = p\.message \|\| "—"/);
  assert.match(html, /textContent: adminTr\("Config store not available\."\)/);
  assert.match(html, /b\.textContent = adminTr\(label\)/);
  assert.match(html, /j\.reason \|\| \(j\.decision === "fastlane" \? adminTr\("@mention — routed past the judge"\)/);
  assert.match(html, /mpre\.textContent = p\.message \|\| adminTr\("\(not recorded\)"\)/);
  assert.match(html, /r\.data\?\.message \|\| `\$\{adminTr\("Failed to load transcript"\)\} \(\$\{r\.status\}\)\.`/);
  assert.match(html, /r\.data\?\.message \|\| `\$\{adminTr\("Search failed"\)\} \(\$\{r\.status\}\)\.`/);
  assert.match(html, /r\.data\?\.message \|\| `\$\{adminTr\("Failed to load mirror"\)\} \(\$\{r\.status\}\)\.`/);
  assert.match(html, /if \(j\.decision === "ignore"\) reason = adminTr\("Stayed silent\."\)/);
  assert.doesNotMatch(html, /emptyPara\(adminTr\(r\.data\?\.message/);
  assert.match(html, /document\.createTextNode\(adminTr\("Slack mirror"\)\)/);
  assert.match(html, /a\.setAttribute\("aria-label", adminTr\("Open in Slack"\)\)/);
  assert.match(html, /pre\.textContent =\s+j\.prompt \|\|\s+adminTr\(/);
  assert.match(html, /badge\(`\$\{adminTr\("asked by"\)\} \$\{j\.askedBy\}`/);
});

test("admin locale also controls date and number formatting", () => {
  assert.match(html, /const adminLocaleCode = \(\) =>/);
  assert.match(html, /new Date\(ts\)\.toLocaleString\(adminLocaleCode\(\)\)/);
  assert.match(html, /Number\(background\)\.toLocaleString\(adminLocaleCode\(\)\)/);
  assert.match(html, /\^\(\[\\d,\.\]\+\[kKmM\]\?\) turns\?/);
  assert.match(html, /return adminTr\(\(n \/ 1000\)/);
  const body = html.match(/const adminTranslatePattern = \(value\) => \{([\s\S]*?)\n {6}\};\n {6}const adminTr/)?.[1];
  assert.ok(body);
  const translatePattern = new Function("value", body) as (value: string) => string | null;
  const dictionary = adminDictionary();
  const adminTr = (value: string) => dictionary[value] ?? translatePattern(value) ?? value;
  assert.equal(translatePattern("1,234 turns"), "1,234 个轮次");
  assert.equal(translatePattern("1.2k tokens"), "1.2k 个令牌");
  assert.equal(translatePattern("4 errors"), "4 个错误");
  assert.equal(translatePattern("3 known scopes without conversations"), "3 个尚无对话的已知范围");
  assert.equal(translatePattern("Open origin session abc123 · fire-key"), "打开来源会话 abc123 · fire-key");
  assert.equal(translatePattern("Scopes: repo, read:org"), "权限范围：repo, read:org");
  assert.equal(adminTr(`3 ${adminTr("eligible")}`), "3 符合条件");
  assert.equal(adminTr(`2 ${adminTr("imported")}`), "2 已导入");
  assert.equal(adminTr(`4 ${adminTr("binary files")}`), "4 二进制文件");
  assert.equal(adminTr("Failed to load"), "加载失败");
  assert.equal(adminTr("Only an org admin can read ambient judgments."), "只有组织管理员可以读取环境判定。");
  assert.equal(adminTr("Slack mirror"), "Slack 镜像");
  assert.equal(adminTr("asked by"), "提问者");
});

test("admin localization preserves identity, secrets, and authored content", () => {
  assert.match(html, /data-i18n-skip/);
  assert.match(
    html,
    /script,style,code,pre,\[data-i18n-skip\],\.mono,\.viewer,\.file-name,\.credential-secret,\.dense-name,\.dense-preview/,
  );
  assert.match(html, /id="who-name" data-i18n-skip/);
  assert.match(html, /id="na-sub" data-i18n-skip/);
});

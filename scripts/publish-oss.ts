// 发版辅助：把 packages/desktop/release/ 产物上传到阿里云 OSS（公开读），供 electron-updater 拉取。
// 用法：OSS_AK=<AccessKeyId> OSS_SK=<AccessKeySecret> bun run scripts/publish-oss.ts <version>
//
// 产物结构（OSS）：
//   coaicom/releases/latest.yml                      # 版本清单（固定路径，覆盖式）
//   coaicom/releases/WaPi-Setup-<version>.exe        # 安装包
//   coaicom/releases/WaPi-Setup-<version>.exe.blockmap
//
// releaseNotes：electron-builder 26 不支持 releaseNotesFile，故这里上传前把
// packages/desktop/RELEASE_NOTES.md 内容注入 latest.yml 的 releaseNotes 字段。
// 若未提供 OSS_AK/OSS_SK，打印手动上传指引后退出（不失败）。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error ali-oss 无内置类型声明
import OSS from "ali-oss";

const version = process.argv[2];
if (!version) {
  console.error("用法: OSS_AK=<id> OSS_SK=<secret> bun run scripts/publish-oss.ts <version>");
  process.exit(1);
}

const REGION = "oss-cn-heyuan";
const BUCKET = "coaicom";
const PREFIX = "releases";
const ak = process.env.OSS_AK;
const sk = process.env.OSS_SK;
const repoRoot = join(import.meta.dir, "..");
const releaseDir = join(repoRoot, "packages", "desktop", "release");
const notesFile = join(repoRoot, "packages", "desktop", "RELEASE_NOTES.md");

interface Artifact {
  path: string;
  /** OSS key（不含 bucket），如 releases/latest.yml */
  key: string;
}

/** 扫 release 目录，挑出 Windows + macOS 平台的更新产物 */
function listArtifacts(): Artifact[] {
  const names = readdirSync(releaseDir);
  const out: Artifact[] = [];
  // electron-updater 按平台读不同清单：Windows 读 latest.yml，macOS 读 latest-mac.yml
  const targets = [
    "latest.yml",
    "latest-mac.yml",
    `WaPi-Setup-${version}.exe`,
    `WaPi-Setup-${version}.exe.blockmap`,
    `WaPi-Setup-${version}.dmg`,
    `WaPi-Setup-${version}.dmg.blockmap`,
    `WaPi-Setup-${version}.zip`,
    `WaPi-Setup-${version}.zip.blockmap`,
  ];
  for (const name of names) {
    if (targets.includes(name)) {
      out.push({ path: join(releaseDir, name), key: `${PREFIX}/${name}` });
    }
  }
  return out;
}

/** 把 RELEASE_NOTES.md 内容注入 latest.yml 的 releaseNotes 字段，返回修改后的文本 */
function injectReleaseNotes(ymlPath: string): string {
  let yml = readFileSync(ymlPath, "utf8");
  if (!existsSync(notesFile)) {
    console.warn(`⚠ 未找到 ${notesFile}，latest.yml 不注入 releaseNotes`);
    return yml;
  }
  const notes = readFileSync(notesFile, "utf8").trim();
  if (!notes) return yml;
  // latest.yml 是 YAML；releaseNotes 含换行，用 YAML 字面量块（|）最稳。
  // 若已有 releaseNotes 行则替换，否则追加。
  const block = `releaseNotes: |-\n${notes.split("\n").map((l) => `  ${l}`).join("\n")}\n`;
  if (/^releaseNotes:/m.test(yml)) {
    yml = yml.replace(/^releaseNotes:[\s\S]*?(?=\n\S|\n$|$)/m, block.trimEnd());
  } else {
    yml = yml.trimEnd() + "\n" + block;
  }
  return yml;
}

// 无 AK/SK：打印手动上传指引
if (!ak || !sk) {
  const artifacts = listArtifacts();
  console.log("未提供 OSS_AK/OSS_SK，以下产物需要手动上传到阿里云 OSS：");
  console.log(`  Bucket: ${BUCKET}（${REGION}，公开读）`);
  for (const a of artifacts) console.log(`  - ${a.path} → ${a.key}`);
  console.log(`\n或配置环境变量后重试：OSS_AK=<id> OSS_SK=<secret> bun run scripts/publish-oss.ts ${version}`);
  process.exit(0);
}

async function main() {
  const artifacts = listArtifacts();
  if (artifacts.length === 0) {
    console.error(`release 目录未找到版本 ${version} 的产物：${releaseDir}`);
    process.exit(1);
  }
  const hasLatestYml = artifacts.some((a) => a.key.endsWith("latest.yml"));
  if (!hasLatestYml) {
    console.error("release 目录缺少 latest.yml（需先在 electron-builder.yml 配 publish 后重新打包）");
    process.exit(1);
  }

  const store = new OSS({
    region: REGION,
    accessKeyId: ak,
    accessKeySecret: sk,
    bucket: BUCKET,
    secure: true,
  });
  // 对象级公开读：终端用户通过 GenericProvider 直接 GET，无需签名
  const headers = { "x-oss-object-acl": "public-read" };

  for (const a of artifacts) {
    if (a.key.endsWith(".exe") || a.key.endsWith(".dmg") || a.key.endsWith(".zip")) {
      // 安装包较大（142~166MB），用分片上传支持进度与断点续传
      const size = statSync(a.path).size;
      console.log(`↑ 分片上传 ${a.key}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
      await store.multipartUpload(a.key, a.path, {
        headers,
        partSize: 5 * 1024 * 1024,
        progress: (p: number) => process.stdout.write(`\r  ${Math.round(p * 100)}%`),
      });
      process.stdout.write("\n");
    } else if (a.key.endsWith(".yml")) {
      // latest.yml / latest-mac.yml：注入 releaseNotes 后上传
      const body = injectReleaseNotes(a.path);
      await store.put(a.key, Buffer.from(body, "utf8"), { headers });
      console.log(`✓ 已上传 ${a.key}（已注入 releaseNotes）`);
    } else {
      // blockmap 等小文件：简单上传
      await store.put(a.key, a.path, { headers });
      console.log(`✓ 已上传 ${a.key}`);
    }
  }

  console.log(`\n✅ 发布完成: https://${BUCKET}.${REGION}.aliyuncs.com/${PREFIX}/latest.yml`);
}

void main();

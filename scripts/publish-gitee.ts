// 发版辅助：把 packages/desktop/release/ 产物上传到 Gitee Release。
// 用法：GITEE_TOKEN=<私人令牌> bun run scripts/publish-gitee.ts <version>
// 若未提供 token，打印手动上传指引后退出（不失败）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("用法: GITEE_TOKEN=<token> bun run scripts/publish-gitee.ts <version>");
  process.exit(1);
}

const OWNER = "luandapipi";
const REPO = "HiAgent";
const API = "https://gitee.com/api/v5";
const token = process.env.GITEE_TOKEN;
const releaseDir = join(import.meta.dir, "..", "packages", "desktop", "release");

function listArtifacts(): Array<{ path: string; name: string; size: number }> {
  return readdirSync(releaseDir)
    .filter((f) => f.endsWith(".exe") || f === "latest.yml")
    .map((f) => ({ path: join(releaseDir, f), name: f, size: statSync(join(releaseDir, f)).size }));
}

if (!token) {
  const artifacts = listArtifacts();
  console.log("未提供 GITEE_TOKEN，以下产物需要手动上传到 Gitee Release：");
  console.log(`  https://gitee.com/${OWNER}/${REPO}/releases/new?tag=v${version}`);
  for (const a of artifacts) console.log(`  - ${a.name} (${a.size} bytes)`);
  process.exit(0);
}

async function main() {
  const artifacts = listArtifacts();
  if (artifacts.length === 0) {
    console.error(`release 目录为空：${releaseDir}`);
    process.exit(1);
  }

  const headers = { "Content-Type": "application/json" };
  // 1) 创建 release（已存在则忽略）
  const createRes = await fetch(`${API}/repos/${OWNER}/${REPO}/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tag_name: `v${version}`,
      name: `v${version}`,
      body: `WA PI Agent v${version}`,
      access_token: token,
    }),
  });
  if (!createRes.ok && createRes.status !== 409) {
    console.error("创建 release 失败:", createRes.status, await createRes.text());
    process.exit(1);
  }
  let releaseId: number;
  if (createRes.status === 409) {
    // tag 已存在：查询已有 release 取 id（补丁发版场景）
    const listRes = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/tags/v${version}?access_token=${token}`);
    if (!listRes.ok) {
      console.error(`tag v${version} 已存在但查询 release 失败:`, listRes.status, await listRes.text());
      console.error(`请手动到 https://gitee.com/${OWNER}/${REPO}/releases/v${version} 上传产物`);
      process.exit(1);
    }
    releaseId = (await listRes.json()).id;
  } else {
    releaseId = (await createRes.json()).id;
  }

  // 2) 上传附件
  for (const a of artifacts) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(a.path)]), a.name);
    form.append("access_token", token);
    const upRes = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/${releaseId}/attach_files`, {
      method: "POST",
      body: form,
    });
    if (!upRes.ok) {
      console.error(`上传 ${a.name} 失败:`, upRes.status, await upRes.text());
      process.exit(1);
    }
    console.log(`✓ 已上传 ${a.name}`);
  }
  console.log(`✅ 发布完成: https://gitee.com/${OWNER}/${REPO}/releases/v${version}`);
}

void main();

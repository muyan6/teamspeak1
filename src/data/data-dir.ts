import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Codes that mean "this process is not allowed to touch that path", as opposed
 * to a genuinely broken path (ENOTDIR/EISDIR/ENOSPC/…). Only these deserve the
 * Docker ownership hint — otherwise the advice would be misleading.
 */
const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export const CONTAINER_RUN_UID = 1000;
export const CONTAINER_RUN_GID = 1000;

export function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && PERMISSION_CODES.has(code);
}

export function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Actionable, host-side instructions. The container runs as a non-root user
 * (UID/GID 1000:1000) since the Docker image was hardened, but bind mounts
 * created by older root-running images are still owned by root — the process
 * then cannot read its own config.json and crash-loops under
 * `restart: unless-stopped`. Nothing inside the container can repair that,
 * so the only useful thing we can do is say exactly what to run on the host.
 *
 * `uid` is deliberately a REQUIRED argument with no default. It used to default
 * to `currentUid()`, which made `dataDirPermissionHint(dir, undefined)` — the
 * natural way to say "the uid is unknown" — silently substitute the real uid
 * instead, because `undefined` triggers a default parameter. That only looked
 * correct on Windows (where `process.getuid` does not exist, so the fallback
 * fired anyway) and made the non-POSIX test fail on every Linux CI runner.
 * Callers that mean "whatever this process is" must now pass `currentUid()`.
 */
export function dataDirPermissionHint(dir: string, uid: number | undefined): string {
  return [
    "",
    "──────────────────────────────────────────────────────────────────────",
    "启动中止：数据目录不可读写 (EACCES/EPERM)",
    `  目录(容器内)  : ${dir}`,
    `  当前进程 UID  : ${uid ?? "n/a (非 POSIX 平台)"}`,
    "",
    "Docker 镜像以非 root 用户 UID/GID 1000:1000 运行。若数据目录是旧版本",
    "(以 root 运行)创建的绑定挂载，其属主仍是 root，容器内进程无法读写",
    "config.json / 数据库 / 日志，进程会立即退出并被自动重启，形成重启循环。",
    "",
    "请在【宿主机】上修复（把路径换成你的实际绑定目录）：",
    "",
    "  # 1) 查出实际的绑定目录",
    "  docker inspect tsmusicbot-custom \\",
    "    --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'",
    "",
    "  # 2) 把属主交给容器内的运行用户",
    `  sudo chown -R ${CONTAINER_RUN_UID}:${CONTAINER_RUN_GID} /data/musicbot`,
    "",
    "  # 3) 重启",
    "  docker compose up -d      # 或 docker restart tsmusicbot-custom",
    "",
    "临时绕过（不推荐，会恢复 root 运行）：在 docker-compose.yml 的该 service",
    "下加一行 `user: root` 后重新 up -d。",
    "──────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}

/**
 * Verify up front that DATA_DIR can actually be used, and fail with the host
 * fix instructions when it cannot. Checks what boot genuinely needs:
 * creating the dir, writing to it, and reading an existing config.json.
 */
export function assertDataDirUsable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });

    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });

    const configPath = join(dir, "config.json");
    if (existsSync(configPath)) readFileSync(configPath, "utf-8");
  } catch (err) {
    if (isPermissionError(err)) {
      throw new Error(dataDirPermissionHint(dir, currentUid()), { cause: err });
    }
    throw err;
  }
}

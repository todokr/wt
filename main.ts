// wt — git worktree switcher with Claude Code history preview
//
// Usage:
//   wt              fzf で worktree を選択 (Enter: パスを stdout に出力 / ctrl-d: 削除)
//   wt list         worktree 一覧を TSV で出力 (内部用: fzf の reload にも使う)
//   wt preview <p>  worktree のプレビュー (git 状態 + Claude Code 履歴) を出力 (内部用)
//   wt rm <p>       worktree を削除 (確認プロンプトあり)
//   wt init zsh     cd 連携用のシェル関数を出力 (.zshrc で eval する)
//
// cd 連携はシェル関数ラッパー (`wt init zsh` が出力) 経由で行う。

const HISTORY_LIMIT = 15;

// ---------- helpers ----------

async function run(
  cmd: string[],
  opts: { cwd?: string; allowFail?: boolean } = {},
): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0 && !opts.allowFail) {
    throw new Error(
      `command failed: ${cmd.join(" ")}\n${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trimEnd();
}

// 自己呼び出し用コマンド文字列 (fzf の preview / bind で使う)。
// `deno run` 実行時と `deno compile` 済みバイナリの両方に対応する。
function selfInvoke(): string {
  const exec = Deno.execPath();
  const base = exec.replaceAll("\\", "/").split("/").pop() ?? "";
  if (base === "deno") {
    const self = new URL(Deno.mainModule).pathname;
    return `"${exec}" run -A "${self}"`;
  }
  return `"${exec}"`;
}

function claudeProjectDir(worktreePath: string): string {
  const home = Deno.env.get("HOME") ?? "";
  const slug = worktreePath.replace(/[^a-zA-Z0-9]/g, "-");
  return `${home}/.claude/projects/${slug}`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return `${sec}s前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h前`;
  return `${Math.floor(sec / 86400)}d前`;
}

// ---------- worktree list ----------

interface Worktree {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

async function getWorktrees(): Promise<Worktree[]> {
  const out = await run(["git", "worktree", "list", "--porcelain"]);
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};
  let first = true;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), isMain: first };
      first = false;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5, 12);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = "(detached)";
    } else if (line === "") {
      if (current.path) worktrees.push(current as Worktree);
      current = {};
    }
  }
  if (current.path) worktrees.push(current as Worktree);
  return worktrees;
}

async function printList() {
  const worktrees = await getWorktrees();
  const home = Deno.env.get("HOME") ?? "";
  for (const wt of worktrees) {
    const display = wt.path.startsWith(home)
      ? "~" + wt.path.slice(home.length)
      : wt.path;
    const mark = wt.isMain ? " [main]" : "";
    console.log(
      `${wt.path}\t${wt.branch ?? "?"}${mark}\t${wt.head ?? ""}\t${display}`,
    );
  }
}

// ---------- Claude Code history ----------

interface HistoryEntry {
  timestamp: string;
  kind: "prompt" | "command";
  text: string;
}

async function collectHistory(worktreePath: string): Promise<HistoryEntry[]> {
  const dir = claudeProjectDir(worktreePath);
  const entries: HistoryEntry[] = [];
  let files: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".jsonl")) files.push(`${dir}/${e.name}`);
    }
  } catch {
    return [];
  }
  // 新しいセッションから読む (mtime 降順) — 十分集まったら打ち切り
  const stats = await Promise.all(
    files.map(async (f) => ({ f, mtime: (await Deno.stat(f)).mtime?.getTime() ?? 0 })),
  );
  files = stats.sort((a, b) => b.mtime - a.mtime).map((s) => s.f);

  for (const file of files) {
    if (entries.length >= HISTORY_LIMIT * 3) break;
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.isMeta) continue;
      // ユーザーの指示
      if (obj.type === "user" && obj.message?.role === "user") {
        const content = obj.message.content;
        let t = "";
        if (typeof content === "string") t = content;
        else if (Array.isArray(content)) {
          t = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join(" ");
        }
        t = t.trim();
        if (!t || t.startsWith("<") || t.startsWith("[Request interrupted")) continue; // command 実行やシステム由来はスキップ
        entries.push({ timestamp: obj.timestamp ?? "", kind: "prompt", text: t });
      }
      // Claude が実行した Bash コマンド
      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const c of obj.message.content) {
          if (c.type === "tool_use" && c.name === "Bash" && c.input?.command) {
            entries.push({
              timestamp: obj.timestamp ?? "",
              kind: "command",
              text: String(c.input.command),
            });
          }
        }
      }
    }
  }
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return entries;
}

// ---------- preview ----------

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

async function printPreview(worktreePath: string) {
  const bold = "\x1b[1m", dim = "\x1b[2m", cyan = "\x1b[36m",
    yellow = "\x1b[33m", green = "\x1b[32m", reset = "\x1b[0m";

  console.log(`${bold}${worktreePath}${reset}`);

  const branch = await run(
    ["git", "-C", worktreePath, "branch", "--show-current"],
    { allowFail: true },
  );
  const lastCommit = await run(
    ["git", "-C", worktreePath, "log", "-1", "--format=%h %s (%cr)"],
    { allowFail: true },
  );
  const status = await run(
    ["git", "-C", worktreePath, "status", "--short"],
    { allowFail: true },
  );
  console.log(`${cyan}branch:${reset} ${branch || "(detached)"}`);
  console.log(`${cyan}commit:${reset} ${lastCommit}`);
  if (status) {
    const lines = status.split("\n");
    console.log(`${cyan}dirty:${reset}  ${lines.length} files`);
    for (const l of lines.slice(0, 5)) console.log(`  ${dim}${l}${reset}`);
    if (lines.length > 5) console.log(`  ${dim}… 他 ${lines.length - 5} 件${reset}`);
  } else {
    console.log(`${cyan}dirty:${reset}  clean`);
  }

  const history = await collectHistory(worktreePath);
  if (history.length === 0) {
    console.log("");
    console.log(`${dim}(このパスの Claude Code セッション履歴なし)${reset}`);
    return;
  }
  const prompts = history.filter((e) => e.kind === "prompt").slice(0, 8);
  const commands = history.filter((e) => e.kind === "command").slice(0, 8);

  console.log("");
  console.log(`${bold}── Claude への指示 ──${reset}`);
  for (const e of prompts) {
    const time = `${dim}${relativeTime(e.timestamp).padStart(5)}${reset}`;
    console.log(`${time} ${yellow}💬${reset} ${truncate(e.text, 200)}`);
  }
  if (prompts.length === 0) console.log(`${dim}(なし)${reset}`);

  console.log("");
  console.log(`${bold}── 実行されたコマンド ──${reset}`);
  for (const e of commands) {
    const time = `${dim}${relativeTime(e.timestamp).padStart(5)}${reset}`;
    console.log(`${time} ${green}$${reset} ${dim}${truncate(e.text, 160)}${reset}`);
  }
  if (commands.length === 0) console.log(`${dim}(なし)${reset}`);
}

// ---------- rm ----------

async function removeWorktree(worktreePath: string) {
  const worktrees = await getWorktrees();
  const target = worktrees.find((w) => w.path === worktreePath);
  if (!target) {
    console.error(`worktree が見つかりません: ${worktreePath}`);
    Deno.exit(1);
  }
  if (target.isMain) {
    console.error("メイン worktree は削除できません");
    prompt("Enter で戻る");
    Deno.exit(1);
  }
  const answer = prompt(
    `${worktreePath} (${target.branch}) を削除しますか？ [y/N]`,
  );
  if (answer?.toLowerCase() !== "y") return;

  const result = await new Deno.Command("git", {
    args: ["worktree", "remove", worktreePath],
    stdout: "inherit",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    const err = new TextDecoder().decode(result.stderr);
    console.error(err.trim());
    if (/contains modified or untracked files/.test(err)) {
      const force = prompt("未コミットの変更があります。強制削除しますか？ [y/N]");
      if (force?.toLowerCase() === "y") {
        await run(["git", "worktree", "remove", "--force", worktreePath]);
        console.error("強制削除しました");
      }
    } else {
      prompt("Enter で戻る");
    }
  }
}

// ---------- interactive (fzf) ----------

async function interactive() {
  const worktrees = await getWorktrees();
  if (worktrees.length === 0) {
    console.error("worktree がありません");
    Deno.exit(1);
  }

  const invoke = selfInvoke();

  let fzf: Deno.ChildProcess;
  try {
    fzf = spawnFzf(invoke);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error("fzf が見つかりません。`brew install fzf` でインストールしてください");
      Deno.exit(1);
    }
    throw e;
  }

  const home = Deno.env.get("HOME") ?? "";
  const lines = worktrees.map((wt) => {
    const display = wt.path.startsWith(home)
      ? "~" + wt.path.slice(home.length)
      : wt.path;
    const mark = wt.isMain ? " [main]" : "";
    return `${wt.path}\t${wt.branch ?? "?"}${mark}\t${wt.head ?? ""}\t${display}`;
  });
  const writer = fzf.stdin.getWriter();
  await writer.write(new TextEncoder().encode(lines.join("\n") + "\n"));
  await writer.close();

  const { code, stdout } = await fzf.output();
  if (code !== 0) Deno.exit(0); // キャンセル
  const selected = new TextDecoder().decode(stdout).trim();
  if (selected) console.log(selected.split("\t")[0]); // シェル関数がこれを cd する
}

function spawnFzf(invoke: string): Deno.ChildProcess {
  return new Deno.Command("fzf", {
    args: [
      "--ansi",
      "--delimiter", "\t",
      "--with-nth", "2,4",
      "--nth", "1,2",
      "--header", "Enter: cd / ctrl-d: 削除 / ctrl-r: 更新",
      "--preview", `${invoke} preview {1}`,
      "--preview-window", "right,65%,wrap",
      "--bind", `ctrl-d:execute(${invoke} rm {1})+reload(${invoke} list)`,
      "--bind", `ctrl-r:reload(${invoke} list)`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
}

// ---------- init (シェル統合) ----------

function printInit(shell: string) {
  if (shell !== "zsh" && shell !== "bash") {
    console.error(`未対応のシェルです: ${shell} (zsh / bash に対応)`);
    Deno.exit(1);
  }
  const exec = Deno.execPath();
  console.log(`\
# wt シェル統合 — .${shell}rc に以下を追記してください:
#   eval "$(${exec.split("/").pop()} init ${shell})"
wt() {
  local dest
  dest=$("${exec}" "$@") || return $?
  if [ $# -eq 0 ] && [ -n "$dest" ] && [ -d "$dest" ]; then
    cd "$dest" || return $?
  elif [ -n "$dest" ]; then
    printf '%s\\n' "$dest"
  fi
}`);
}

// ---------- main ----------

// git リポジトリ内かチェック (preview/rm はパス指定なので不要)
const [cmd, arg] = Deno.args;
switch (cmd) {
  case "list":
    await printList();
    break;
  case "preview":
    if (!arg) Deno.exit(1);
    await printPreview(arg);
    break;
  case "rm":
    if (!arg) Deno.exit(1);
    await removeWorktree(arg);
    break;
  case "init":
    printInit(arg ?? "zsh");
    break;
  case undefined:
    await interactive();
    break;
  default:
    console.error(`不明なサブコマンド: ${cmd}`);
    Deno.exit(1);
}

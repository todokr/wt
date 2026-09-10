// wt — git worktree switcher with Claude Code history preview
//
// Usage:
//   wt              fzf で worktree を選択 (Enter: パスを stdout に出力 / ctrl-d: 削除)
//   wt <keyword>    Claude Code の会話履歴に keyword を含む worktree に絞って fzf 起動
//   wt list [kw]    worktree 一覧を TSV で出力 (内部用: fzf の reload にも使う)
//   wt preview <p>  worktree のプレビュー (git 状態 + Claude Code 履歴) を出力 (内部用)
//   wt rm <p>       worktree を削除 (確認プロンプトあり)
//   wt new <branch> [<base>] [-m "task"] [--dir <slug>]
//                  ブランチ + worktree を新規作成して cd (base 省略時は main)
//                  既存ブランチは流用。--dir でディレクトリ名を分離指定できる
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

// ---------- worktree metadata (~/.wt/meta.json) ----------

interface WorktreeMeta {
  fields: Record<string, string>;
  updatedAt?: string;
}

function metaFilePath(): string {
  return `${Deno.env.get("HOME") ?? ""}/.wt/meta.json`;
}

async function readAllMeta(): Promise<Record<string, WorktreeMeta>> {
  try {
    const text = await Deno.readTextFile(metaFilePath());
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") return obj as Record<string, WorktreeMeta>;
  } catch {
    // ファイル無し / パース失敗 → 空
  }
  return {};
}

async function writeAllMeta(all: Record<string, WorktreeMeta>): Promise<void> {
  const path = metaFilePath();
  const dir = path.replace(/\/[^/]+$/, "");
  await Deno.mkdir(dir, { recursive: true }).catch(() => {});
  await Deno.writeTextFile(path, JSON.stringify(all, null, 2) + "\n");
}

async function readMeta(path: string): Promise<WorktreeMeta> {
  const all = await readAllMeta();
  return all[path] ?? { fields: {} };
}

async function setField(path: string, key: string, value: string): Promise<void> {
  const all = await readAllMeta();
  const entry = all[path] ?? { fields: {} };
  if (!entry.fields) entry.fields = {};
  entry.fields[key] = value;
  entry.updatedAt = new Date().toISOString();
  all[path] = entry;
  await writeAllMeta(all);
}

async function unsetField(path: string, key: string): Promise<void> {
  const all = await readAllMeta();
  const entry = all[path];
  if (!entry || !entry.fields || !(key in entry.fields)) return;
  delete entry.fields[key];
  if (Object.keys(entry.fields).length === 0) {
    delete all[path];
  } else {
    entry.updatedAt = new Date().toISOString();
    all[path] = entry;
  }
  await writeAllMeta(all);
}

async function deleteMeta(path: string): Promise<void> {
  const all = await readAllMeta();
  if (!(path in all)) return;
  delete all[path];
  await writeAllMeta(all);
}

// 慣習キーからサマリ 1 行を組み立てる (fzf 一覧の右端表示用)
function metaSummary(meta: WorktreeMeta | undefined): string {
  if (!meta || !meta.fields) return "";
  return meta.fields.status ?? meta.fields.task ?? "";
}

// preview 表示用の key 並び順: task → status → その他辞書順
function orderedMetaKeys(fields: Record<string, string>): string[] {
  const keys = Object.keys(fields);
  const preferred = ["task", "status"];
  const head = preferred.filter((k) => k in fields);
  const rest = keys.filter((k) => !preferred.includes(k)).sort();
  return [...head, ...rest];
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
  meta?: WorktreeMeta;
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
  const allMeta = await readAllMeta();
  for (const w of worktrees) w.meta = allMeta[w.path];
  return worktrees;
}

// keyword を Claude Code の会話履歴 (指示 + コマンド) に含む worktree だけを残す
async function filterByHistory(
  worktrees: Worktree[],
  keyword: string,
): Promise<Worktree[]> {
  const kw = keyword.toLowerCase();
  const matches = await Promise.all(
    worktrees.map(async (wt) => {
      const history = await collectHistory(wt.path);
      return history.some((e) => e.text.toLowerCase().includes(kw));
    }),
  );
  return worktrees.filter((_, i) => matches[i]);
}

async function printList(keyword?: string) {
  let worktrees = await getWorktrees();
  if (keyword) worktrees = await filterByHistory(worktrees, keyword);
  const home = Deno.env.get("HOME") ?? "";
  for (const wt of worktrees) {
    const display = wt.path.startsWith(home)
      ? "~" + wt.path.slice(home.length)
      : wt.path;
    const mark = wt.isMain ? " [main]" : "";
    const summary = truncate(metaSummary(wt.meta), 40);
    console.log(
      `${wt.path}\t${wt.branch ?? "?"}${mark}\t${wt.head ?? ""}\t${display}\t${summary}`,
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

// term の最初の出現箇所が見えるように、その周辺を切り出して max 文字に収める
function excerptAround(s: string, term: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  const idx = oneLine.toLowerCase().indexOf(term.toLowerCase());
  if (oneLine.length <= max || idx < 0) return truncate(oneLine, max);
  const start = Math.max(
    0,
    Math.min(idx - Math.floor(max / 3), oneLine.length - max),
  );
  const slice = oneLine.slice(start, start + max);
  return (start > 0 ? "…" : "") + slice +
    (start + max < oneLine.length ? "…" : "");
}

// term の出現箇所を黄背景でハイライト。restore はハイライト後に復帰する SGR (dim など)
function highlight(s: string, term: string | undefined, restore = ""): string {
  if (!term) return s;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(
    new RegExp(escaped, "gi"),
    (m) => `\x1b[30;43m${m}\x1b[0m${restore}`,
  );
}

async function printPreview(worktreePath: string, term?: string) {
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

  const meta = await readMeta(worktreePath);
  const metaKeys = orderedMetaKeys(meta.fields ?? {});
  if (metaKeys.length === 0) {
    console.log(`${dim}meta:   (未設定 — wt set <key> <value> で登録)${reset}`);
  } else {
    const pad = Math.max(...metaKeys.map((k) => k.length), 6);
    for (const k of metaKeys) {
      const label = `${k}:`.padEnd(pad + 1);
      console.log(`${cyan}${label}${reset} ${truncate(meta.fields[k], 200)}`);
    }
    if (meta.updatedAt) {
      console.log(`${dim}        (更新 ${relativeTime(meta.updatedAt)})${reset}`);
    }
  }

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

  // 検索語があるときは、検索対象と同じ範囲から一致エントリだけを表示する
  // (通常表示の各8件に一致箇所が含まれず「ヒットしたのに見えない」のを防ぐ)
  if (term) {
    const kw = term.toLowerCase();
    const hits = history.filter((e) => e.text.toLowerCase().includes(kw));
    console.log("");
    console.log(`${bold}── 「${term}」を含む履歴 (${hits.length}件) ──${reset}`);
    for (const e of hits) {
      const time = `${dim}${relativeTime(e.timestamp).padStart(5)}${reset}`;
      if (e.kind === "prompt") {
        console.log(
          `${time} ${yellow}💬${reset} ${highlight(excerptAround(e.text, term, 200), term)}`,
        );
      } else {
        console.log(
          `${time} ${green}$${reset} ${dim}${highlight(excerptAround(e.text, term, 160), term, dim)}${reset}`,
        );
      }
    }
    if (hits.length === 0) {
      console.log(`${dim}(直近 ${history.length} エントリに一致なし)${reset}`);
    }
    return;
  }

  const prompts = history.filter((e) => e.kind === "prompt").slice(0, 8);
  const commands = history.filter((e) => e.kind === "command").slice(0, 8);

  console.log("");
  console.log(`${bold}── Claude への指示 ──${reset}`);
  for (const e of prompts) {
    const time = `${dim}${relativeTime(e.timestamp).padStart(5)}${reset}`;
    console.log(`${time} ${yellow}💬${reset} ${highlight(truncate(e.text, 200), term)}`);
  }
  if (prompts.length === 0) console.log(`${dim}(なし)${reset}`);

  console.log("");
  console.log(`${bold}── 実行されたコマンド ──${reset}`);
  for (const e of commands) {
    const time = `${dim}${relativeTime(e.timestamp).padStart(5)}${reset}`;
    console.log(
      `${time} ${green}$${reset} ${dim}${highlight(truncate(e.text, 160), term, dim)}${reset}`,
    );
  }
  if (commands.length === 0) console.log(`${dim}(なし)${reset}`);
}

// ---------- rm ----------

// ディレクトリは残っているが .git を失った worktree か。
// git の stderr は locale で翻訳されるためメッセージでは判定しない。
async function isBrokenWorktreeDir(path: string): Promise<boolean> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch {
    return false;
  }
  if (!info.isDirectory || info.isSymlink) return false; // symlink は再帰削除しない
  try {
    await Deno.stat(`${path}/.git`);
    return false;
  } catch (e) {
    return e instanceof Deno.errors.NotFound;
  }
}

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
  if (result.code === 0) {
    await deleteMeta(worktreePath);
  } else {
    const err = new TextDecoder().decode(result.stderr);
    console.error(err.trim());
    if (/contains modified or untracked files/.test(err)) {
      const force = prompt("未コミットの変更があります。強制削除しますか？ [y/N]");
      if (force?.toLowerCase() === "y") {
        await run(["git", "worktree", "remove", "--force", worktreePath]);
        await deleteMeta(worktreePath);
        console.error("強制削除しました");
      }
    } else if (await isBrokenWorktreeDir(worktreePath)) {
      // .git を失った worktree は --force でも消せない
      const mainPath = worktrees.find((w) => w.isMain)?.path;
      if (!mainPath) {
        console.error("メイン worktree が特定できません");
        prompt("Enter で戻る");
        return;
      }
      console.error(
        `${worktreePath}/.git が失われているため、ディレクトリごと削除します (未コミットの変更は復元できません)`,
      );
      // cwd が消えると Deno は子プロセスを spawn できなくなるので先に退避する
      Deno.chdir(mainPath);
      try {
        await Deno.remove(worktreePath, { recursive: true });
      } catch (e) {
        console.error(
          `ディレクトリの削除に失敗しました: ${
            e instanceof Error ? e.message : e
          }`,
        );
        console.error("手動で削除してから再実行してください");
        prompt("Enter で戻る");
        return;
      }
      const retry = await new Deno.Command("git", {
        args: ["-C", mainPath, "worktree", "remove", worktreePath],
        stdout: "inherit",
        stderr: "piped",
      }).output();
      let unregistered = retry.code === 0;
      if (!unregistered) {
        console.error(new TextDecoder().decode(retry.stderr).trim());
        console.error(
          "git worktree prune で登録を掃除します (このリポジトリの他の壊れたエントリも一覧から消えます)",
        );
        await run(["git", "-C", mainPath, "worktree", "prune"], {
          allowFail: true,
        });
        // prune は lock 済み worktree を飛ばすため実際に消えたか確認する
        const listed = await run(
          ["git", "-C", mainPath, "worktree", "list", "--porcelain"],
          { allowFail: true },
        );
        unregistered = !listed.split("\n").includes(`worktree ${worktreePath}`);
      }
      await deleteMeta(worktreePath);
      console.error(
        unregistered
          ? "ディレクトリごと削除しました"
          : `ディレクトリは削除しましたが git の登録が残っています。git -C ${mainPath} worktree unlock ${worktreePath} の後に再実行してください`,
      );
      prompt("Enter で戻る");
    } else {
      prompt("Enter で戻る");
    }
  }
}

// ---------- interactive (fzf) ----------

async function interactive(keyword?: string) {
  let worktrees = await getWorktrees();
  if (worktrees.length === 0) {
    console.error("worktree がありません");
    Deno.exit(1);
  }
  if (keyword) {
    worktrees = await filterByHistory(worktrees, keyword);
    if (worktrees.length === 0) {
      console.error(`会話履歴に「${keyword}」を含む worktree はありません`);
      Deno.exit(1);
    }
  }

  const invoke = selfInvoke();

  // ctrl-f で指定した検索語をプレビューのハイライトに引き継ぐための状態ファイル
  const termFile = await Deno.makeTempFile({ prefix: "wt-term-" });
  if (keyword) await Deno.writeTextFile(termFile, keyword);

  let fzf: Deno.ChildProcess;
  try {
    fzf = spawnFzf(invoke, termFile, keyword);
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
    const summary = truncate(metaSummary(wt.meta), 40);
    return `${wt.path}\t${wt.branch ?? "?"}${mark}\t${wt.head ?? ""}\t${display}\t${summary}`;
  });
  const writer = fzf.stdin.getWriter();
  await writer.write(new TextEncoder().encode(lines.join("\n") + "\n"));
  await writer.close();

  const { code, stdout } = await fzf.output();
  await Deno.remove(termFile).catch(() => {});
  if (code !== 0) Deno.exit(0); // キャンセル
  const selected = new TextDecoder().decode(stdout).trim();
  if (selected) console.log(selected.split("\t")[0]); // シェル関数がこれを cd する
}

function spawnFzf(
  invoke: string,
  termFile: string,
  keyword?: string,
): Deno.ChildProcess {
  const header = (keyword ? `[会話に「${keyword}」を含む worktree] ` : "") +
    "Enter: cd / ctrl-d: 削除 / ctrl-f: 会話内容で絞り込み / ctrl-r: 全件表示";
  return new Deno.Command("fzf", {
    args: [
      "--ansi",
      "--delimiter", "\t",
      "--with-nth", "2,4,5",
      "--nth", "1,2,5",
      "--header", header,
      "--preview", `${invoke} preview {1} {q}`,
      "--preview-window", "up,60%,wrap",
      "--bind", `ctrl-d:execute(${invoke} rm {1})+reload(${invoke} list)`,
      "--bind",
      `ctrl-f:execute-silent(${invoke} setterm {q})+reload(${invoke} list {q})+clear-query`,
      "--bind", `ctrl-r:execute-silent(${invoke} setterm)+reload(${invoke} list)`,
    ],
    env: { WT_TERM_FILE: termFile },
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
  if [ -n "$dest" ] && [ -d "$dest" ]; then
    cd "$dest" || return $?
  elif [ -n "$dest" ]; then
    printf '%s\\n' "$dest"
  fi
}`);
}

// ---------- meta subcommands ----------

// 引数から --path <p> / --json / --all / -m|--message <s> フラグと位置引数を分離
function parseArgs(
  args: string[],
): {
  positional: string[];
  flags: {
    json: boolean;
    all: boolean;
    path?: string;
    message?: string;
    dir?: string;
  };
} {
  const positional: string[] = [];
  const flags: {
    json: boolean;
    all: boolean;
    path?: string;
    message?: string;
    dir?: string;
  } = { json: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--path") flags.path = args[++i];
    else if (a.startsWith("--path=")) flags.path = a.slice("--path=".length);
    else if (a === "-m" || a === "--message") flags.message = args[++i];
    else if (a.startsWith("--message=")) {
      flags.message = a.slice("--message=".length);
    } else if (a === "--dir") flags.dir = args[++i];
    else if (a.startsWith("--dir=")) flags.dir = a.slice("--dir=".length);
    else positional.push(a);
  }
  return { positional, flags };
}

async function resolveWorktreePath(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const top = await run(["git", "rev-parse", "--show-toplevel"], {
    allowFail: true,
  });
  if (!top) {
    console.error("git worktree 内で実行するか --path で指定してください");
    Deno.exit(1);
  }
  return top;
}

async function cmdSet(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const [key, ...valueParts] = positional;
  if (!key || valueParts.length === 0) {
    console.error("使い方: wt set <key> <value...> [--path <p>]");
    Deno.exit(1);
  }
  const path = await resolveWorktreePath(flags.path);
  await setField(path, key, valueParts.join(" "));
}

async function cmdUnset(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const [key] = positional;
  if (!key) {
    console.error("使い方: wt unset <key> [--path <p>]");
    Deno.exit(1);
  }
  const path = await resolveWorktreePath(flags.path);
  await unsetField(path, key);
}

async function cmdGet(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const [key] = positional;
  if (!key) {
    console.error("使い方: wt get <key> [--path <p>]");
    Deno.exit(1);
  }
  const path = await resolveWorktreePath(flags.path);
  const meta = await readMeta(path);
  const val = meta.fields?.[key];
  if (val === undefined) Deno.exit(1);
  console.log(val);
}

async function cmdClear(args: string[]) {
  const { flags } = parseArgs(args);
  const path = await resolveWorktreePath(flags.path);
  await deleteMeta(path);
}

interface InfoRecord {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  fields: Record<string, string>;
  updatedAt?: string;
  dirty: number;
}

async function buildInfo(wt: Worktree): Promise<InfoRecord> {
  const status = await run(
    ["git", "-C", wt.path, "status", "--short"],
    { allowFail: true },
  );
  const dirty = status ? status.split("\n").length : 0;
  return {
    path: wt.path,
    branch: wt.branch,
    head: wt.head,
    isMain: wt.isMain,
    fields: wt.meta?.fields ?? {},
    updatedAt: wt.meta?.updatedAt,
    dirty,
  };
}

function printInfoHuman(rec: InfoRecord) {
  const bold = "\x1b[1m", dim = "\x1b[2m", cyan = "\x1b[36m", reset = "\x1b[0m";
  console.log(`${bold}${rec.path}${reset}`);
  console.log(`${cyan}branch:${reset} ${rec.branch || "(detached)"}${rec.isMain ? " [main]" : ""}`);
  console.log(`${cyan}head:${reset}   ${rec.head}`);
  console.log(`${cyan}dirty:${reset}  ${rec.dirty} files`);
  const keys = orderedMetaKeys(rec.fields);
  if (keys.length === 0) {
    console.log(`${dim}meta:   (未設定 — wt set <key> <value> で登録)${reset}`);
  } else {
    const pad = Math.max(...keys.map((k) => k.length), 6);
    for (const k of keys) {
      console.log(`${cyan}${(k + ":").padEnd(pad + 1)}${reset} ${rec.fields[k]}`);
    }
    if (rec.updatedAt) {
      console.log(`${dim}        (更新 ${relativeTime(rec.updatedAt)})${reset}`);
    }
  }
}

async function cmdInfo(args: string[]) {
  const { positional, flags } = parseArgs(args);
  if (flags.all) {
    const worktrees = await getWorktrees();
    const records = await Promise.all(worktrees.map(buildInfo));
    if (flags.json) {
      console.log(JSON.stringify(records, null, 2));
    } else {
      for (const rec of records) {
        printInfoHuman(rec);
        console.log("");
      }
    }
    return;
  }
  const path = await resolveWorktreePath(flags.path ?? positional[0]);
  const worktrees = await getWorktrees();
  const wt = worktrees.find((w) => w.path === path);
  if (!wt) {
    console.error(`worktree が見つかりません: ${path}`);
    Deno.exit(1);
  }
  const rec = await buildInfo(wt);
  if (flags.json) console.log(JSON.stringify(rec, null, 2));
  else printInfoHuman(rec);
}

// ---------- new (worktree + branch 作成) ----------

// メイン (最初の) worktree の絶対パスを返す
async function getMainWorktreePath(): Promise<string> {
  const out = await run(["git", "worktree", "list", "--porcelain"], {
    allowFail: true,
  });
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice(9);
  }
  throw new Error("git worktree が見つかりません");
}

// 新規 worktree の配置先ディレクトリを決定
// - $WT_BASE_DIR があれば ${WT_BASE_DIR}/${name}
// - それ以外はメイン worktree 直下の worktrees/${name}
function resolveNewWorktreePath(name: string, mainPath: string): string {
  const base = Deno.env.get("WT_BASE_DIR");
  if (base && base.length > 0) return `${base.replace(/\/$/, "")}/${name}`;
  return `${mainPath}/.worktree/${name}`;
}

// base 引数省略時のデフォルト分岐元を決定
async function resolveDefaultBase(mainPath: string): Promise<string> {
  for (const cand of ["main", "master"]) {
    const ok = await run(
      ["git", "-C", mainPath, "rev-parse", "--verify", "--quiet", cand],
      { allowFail: true },
    );
    if (ok) return cand;
  }
  const head = await run(
    ["git", "-C", mainPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { allowFail: true },
  );
  if (head) return head; // 例: "origin/main"
  throw new Error(
    "デフォルト分岐元が見つかりません (main / master / origin/HEAD いずれも無し)。base を明示指定してください",
  );
}

async function cmdNew(args: string[]) {
  const { positional, flags } = parseArgs(args);
  const [name, baseArg] = positional;
  if (!name) {
    console.error(
      '使い方: wt new <branch> [<base>] [-m "task"] [--dir <slug>]',
    );
    Deno.exit(1);
  }

  const mainPath = await getMainWorktreePath();
  const dirName = flags.dir ?? name;
  const targetPath = resolveNewWorktreePath(dirName, mainPath);

  // 既存 dir チェック（git worktree add でも失敗するが、事前に分かりやすいメッセージで落とす）
  try {
    const info = await Deno.stat(targetPath);
    if (info.isDirectory) {
      console.error(`既にディレクトリが存在します: ${targetPath}`);
      Deno.exit(1);
    }
  } catch { /* 存在しない → OK */ }

  // ブランチが既存なら流用 (git worktree add <path> <branch>)、無ければ新規 (-b <branch> <path> <base>)
  const branchExists = await run(
    ["git", "-C", mainPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
    { allowFail: true },
  );

  let gitArgs: string[];
  if (branchExists) {
    if (baseArg) {
      console.error(
        `ブランチ ${name} は既存です。base 引数は新規ブランチ作成時のみ指定できます`,
      );
      Deno.exit(1);
    }
    gitArgs = ["-C", mainPath, "worktree", "add", targetPath, name];
  } else {
    const base = baseArg ?? (await resolveDefaultBase(mainPath));
    gitArgs = ["-C", mainPath, "worktree", "add", "-b", name, targetPath, base];
  }

  const result = await new Deno.Command("git", {
    args: gitArgs,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (result.code !== 0) Deno.exit(result.code);

  // 作成された worktree の絶対パスを取り直す (シンボリックリンク解決など)
  const absPath = await run(
    ["git", "-C", targetPath, "rev-parse", "--show-toplevel"],
    { allowFail: true },
  );
  const finalPath = absPath || targetPath;

  if (flags.message) {
    await setField(finalPath, "task", flags.message);
  }

  // シェル関数が cd するために path を stdout に出す
  console.log(finalPath);
}

// ---------- main ----------

// git リポジトリ内かチェック (preview/rm はパス指定なので不要)
const [cmd, arg, arg2] = Deno.args;
switch (cmd) {
  case "list":
    await printList(arg || undefined);
    break;
  case "preview": {
    if (!arg) Deno.exit(1);
    let term = arg2;
    if (!term) {
      const termFile = Deno.env.get("WT_TERM_FILE");
      if (termFile) {
        term = await Deno.readTextFile(termFile).catch(() => "");
      }
    }
    await printPreview(arg, (term ?? "").trim() || undefined);
    break;
  }
  case "setterm": {
    // ctrl-f の検索語を状態ファイルへ保存 (引数なしでクリア)
    const termFile = Deno.env.get("WT_TERM_FILE");
    if (termFile) await Deno.writeTextFile(termFile, arg ?? "");
    break;
  }
  case "rm":
    if (!arg) Deno.exit(1);
    await removeWorktree(arg);
    break;
  case "init":
    printInit(arg ?? "zsh");
    break;
  case "set":
    await cmdSet(Deno.args.slice(1));
    break;
  case "unset":
    await cmdUnset(Deno.args.slice(1));
    break;
  case "get":
    await cmdGet(Deno.args.slice(1));
    break;
  case "clear":
    await cmdClear(Deno.args.slice(1));
    break;
  case "info":
    await cmdInfo(Deno.args.slice(1));
    break;
  case "new":
    await cmdNew(Deno.args.slice(1));
    break;
  case undefined:
    await interactive();
    break;
  default:
    // サブコマンド以外は会話履歴の検索キーワードとして扱う
    await interactive(cmd);
    break;
}

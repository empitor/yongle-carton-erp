// npm run check:apps：检查两个应用外壳（apps/，不在 npm run check 里，因为要另装 JDK、安卓 SDK、Rust）。全部离线，不下载依赖。
// 安卓：gradlew --offline check（Lint、javac 告警、Checkstyle、运行时依赖为空、JVM 单元测试）。
// Windows：cargo fmt --check → cargo clippy --all-targets -D warnings → cargo test → 边界检查（它读 cargo metadata 和编译生成物，排在最后）。
// 工具链在两个外壳 scripts/env.ps1 的默认位置（%LOCALAPPDATA%\YongleToolchains\android、rust）找，环境变量由这里设好再调，
// 不用先 . .\scripts\env.ps1；缺什么就列出来、这个外壳不跑。只跑一个：npm run check:apps -- android（或 desktop）。
// 每步一行结果；哪步不过就打出它的输出、这个外壳停下，另一个照跑；有没过的或缺工具的，退出码 1。只在开发机上跑。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const exe = (name) => (windows ? name + '.exe' : name);

/** 在 PATH 前面加一个目录（Windows 上环境变量名不分大小写，沿用已有的那个键） */
function withPath(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: dir + delimiter + (env[key] ?? '') };
}

/** 安卓外壳：工具目录里的 jdk\、sdk\、gradle-home\（见 apps/android/scripts/env.ps1） */
function android(tools) {
  const jdk = join(tools, 'android', 'jdk'),
    sdk = join(tools, 'android', 'sdk'),
    gradleHome = join(tools, 'android', 'gradle-home');
  // 写明当前目录：设了 NoDefaultCurrentDirectoryInExePath 的 cmd 不在当前目录里找命令
  const gradle = windows ? '.\\gradlew.bat' : 'sh ./gradlew';
  return {
    name: '安卓外壳',
    dir: join(root, 'apps', 'android'),
    guide: 'apps/android/docs/构建与测试.md',
    needs: [
      [join(jdk, 'bin', exe('java')), 'JDK 21'],
      [join(sdk, 'platforms', 'android-36'), '安卓 SDK 的 platforms/android-36'],
      [join(sdk, 'build-tools', '36.0.0'), '安卓 SDK 的 build-tools/36.0.0'],
      [gradleHome, 'Gradle 的发行版和依赖缓存（联网构建过一次才有）'],
    ],
    env: withPath({ ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk, GRADLE_USER_HOME: gradleHome }, join(jdk, 'bin')),
    // gradlew.bat 要经 cmd 跑，整条命令写成一句交给 shell
    steps: [{ name: 'Lint、Checkstyle、单元测试（gradlew check）', shell: `${gradle} --offline --console=plain check` }],
  };
}

/** Windows 外壳：工具目录里的 rust\rustup、rust\cargo（见 apps/desktop/scripts/env.ps1） */
function desktop(tools) {
  const rustup = join(tools, 'rust', 'rustup'),
    cargoHome = join(tools, 'rust', 'cargo'),
    cargo = join(cargoHome, 'bin', exe('cargo'));
  const manifest = ['--manifest-path', join('src-tauri', 'Cargo.toml')];
  return {
    name: 'Windows 外壳',
    dir: join(root, 'apps', 'desktop'),
    guide: 'apps/desktop/docs/构建与测试.md',
    only: windows ? null : 'Windows 外壳只能在 Windows 上检查',
    needs: [
      [cargo, 'Rust 工具链（cargo，带 clippy、rustfmt）'],
      [rustup, 'rustup 的工具链目录'],
    ],
    env: withPath({ ...process.env, RUSTUP_HOME: rustup, CARGO_HOME: cargoHome }, join(cargoHome, 'bin')),
    steps: [
      { name: '格式（cargo fmt --check）', cmd: [cargo, ['fmt', ...manifest, '--check']] },
      { name: '代码检查（cargo clippy -D warnings）', cmd: [cargo, ['clippy', '--offline', ...manifest, '--all-targets', '--', '-D', 'warnings']] },
      { name: '单元测试（cargo test）', cmd: [cargo, ['test', '--offline', ...manifest]] },
      { name: '边界检查（tests/boundary.test.mjs）', cmd: [process.execPath, ['--test', join('tests', 'boundary.test.mjs')]] },
    ],
  };
}

const shells = { android, desktop };

/** 跑一步：命令和参数分开给（cmd），或整条交给 shell（shell）；输出收起来，不过时再打 */
function run(step, shell) {
  const options = { cwd: shell.dir, env: shell.env, stdio: ['ignore', 'pipe', 'pipe'] };
  const child = step.shell ? spawn(step.shell, { ...options, shell: true }) : spawn(step.cmd[0], step.cmd[1], options);
  return new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (b) => (text += b));
    child.stderr.on('data', (b) => (text += b));
    child.on('error', (e) => resolve({ ok: false, text: text + String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, text }));
  });
}

/** 检查一个外壳：缺工具就列出来不跑；否则按顺序跑，哪步不过就停。返回过没过 */
async function check(shell, tools) {
  const missing = shell.only ? [shell.only] : shell.needs.filter(([path]) => !existsSync(path)).map(([path, what]) => `${what}：${path}`);
  if (missing.length) {
    console.log(`✗ ${shell.name}没跑，缺：\n  ${missing.join('\n  ')}\n  装法见 ${shell.guide}“工具链”（工具目录 ${tools}）`);
    return false;
  }
  for (const step of shell.steps) {
    const started = Date.now();
    const result = await run(step, shell);
    const sec = Math.round((Date.now() - started) / 1000) + ' 秒';
    if (!result.ok) {
      console.log(`✗ ${shell.name}：${step.name}（${sec}）没过，输出：\n${result.text.trimEnd()}`);
      return false;
    }
    console.log(`✓ ${shell.name}：${step.name}（${sec}）`);
  }
  return true;
}

const picked = process.argv.slice(2);
const unknown = picked.filter((name) => !Object.hasOwn(shells, name));
if (unknown.length) {
  console.log(`不认识：${unknown.join('、')}。只能写 android、desktop，不写就两个都跑。`);
  process.exit(1);
}
if (!process.env.LOCALAPPDATA) {
  console.log('没有 LOCALAPPDATA 环境变量，找不到工具目录 %LOCALAPPDATA%\\YongleToolchains（两个外壳只在 Windows 开发机上本地检查）。');
  process.exit(1);
}
const tools = join(process.env.LOCALAPPDATA, 'YongleToolchains');
const failed = [];
for (const name of picked.length ? picked : Object.keys(shells)) {
  const shell = shells[name](tools);
  if (!(await check(shell, tools))) failed.push(shell.name);
}
console.log(failed.length ? `外壳检查没过：${failed.join('、')}。` : '外壳检查全部通过。');
process.exit(failed.length ? 1 : 0);

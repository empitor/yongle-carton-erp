package cn.nbyongle.erp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.Test;

/**
 * 外壳的边界：产品源码正好是登记表里的文件，每个文件只引登记的产品文件、登记表没有循环；纯规则文件只引 JDK；
 * 构建配置不引用本目录以外的文件；文件不超过 500 行。运行时不许有第三方库由 Gradle 的 checkNoRuntimeLibraries 守着。
 * 单元测试的工作目录是 app/。
 */
public class ShellBoundaryTest {
    private static final Path APP = Paths.get("").toAbsolutePath();
    private static final Path PROJECT = APP.getParent();
    private static final int MAX_LINES = 500;

    /** 登记表：每个产品源码文件能引哪几个产品文件（只往下引，分层见 docs/架构说明.md“分层和登记表”） */
    private static final Map<String, List<String>> USES = Map.ofEntries(
            Map.entry("MainActivity", List.of("AppUpdater", "BackKey", "BridgeChannel", "FileChooser", "FileSaver", "LaunchScreen",
                    "ShareInbox", "Shell", "SystemBars", "WebRules")),
            Map.entry("FileSaver", List.of("Shell")),
            Map.entry("ShareBatches", List.of("ShareRelay", "Shell")),
            Map.entry("AppUpdater", List.of("InstallStatusReceiver", "Shell")),
            Map.entry("InstallStatusReceiver", List.of("Shell")),
            Map.entry("BackKey", List.of()),
            Map.entry("BridgeChannel", List.of("Shell")),
            Map.entry("FileChooser", List.of("Shell")),
            Map.entry("LaunchScreen", List.of()),
            Map.entry("ShareInbox", List.of("ShareBatches", "ShareRelay", "Shell")),
            Map.entry("ShareRelay", List.of()),
            Map.entry("Shell", List.of()),
            Map.entry("SystemBars", List.of("Shell")),
            Map.entry("WebRules", List.of()));

    /** 各文件能 import 什么：纯规则文件只引 JDK（WebRules 另许 WebViewClient，只用它的错误码常量），其余许平台、JDK、org.json */
    private static final String PLATFORM = "(android|java|org\\.json)\\..*";
    private static final Map<String, String> IMPORTS = Map.of(
            "BackKey", "java\\..*",
            "ShareRelay", "java\\..*",
            "WebRules", "java\\..*|android\\.webkit\\.WebViewClient");

    /** 构建配置里指向本目录以外的写法：上一级、Windows 盘符、引号开头的绝对路径（XML 的 "/> 不算） */
    private static final Pattern ESCAPING = Pattern.compile("\\.\\.[/\\\\]|[\"']\\.\\.[\"']|(?<![A-Za-z])[A-Za-z]:[/\\\\]|[\"']/(?![/>])");

    @Test
    public void productionCodeIsTheRegisteredFiles() throws IOException {
        List<String> registered = USES.keySet().stream().map(name -> "src/main/java/cn/nbyongle/erp/" + name + ".java")
                .sorted().collect(Collectors.toList());
        List<String> found = sourcesOutsideTests().stream().map(f -> APP.relativize(f).toString().replace('\\', '/'))
                .sorted().collect(Collectors.toList());
        assertEquals(registered, found);
    }

    @Test
    public void filesOnlyUseTheRegisteredFiles() throws IOException {
        List<String> unregistered = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : USES.entrySet()) {
            String code = withoutCommentsAndLiterals(read(source(entry.getKey())));
            for (String other : USES.keySet()) {
                boolean allowed = other.equals(entry.getKey()) || entry.getValue().contains(other);
                if (!allowed && Pattern.compile("\\b" + other + "\\b").matcher(code).find()) unregistered.add(entry.getKey() + " → " + other);
            }
        }
        assertEquals(List.of(), unregistered);
    }

    @Test
    public void registryHasNoCycles() {
        Set<String> done = new HashSet<>();
        for (String name : USES.keySet()) visit(name, new ArrayList<>(), done);
    }

    @Test
    public void sourcesImportOnlyWhatTheirLayerAllows() throws IOException {
        List<String> foreign = new ArrayList<>();
        for (String name : USES.keySet()) {
            String allowed = IMPORTS.getOrDefault(name, PLATFORM);
            Files.readAllLines(source(name), StandardCharsets.UTF_8).stream()
                    .filter(line -> line.startsWith("import "))
                    .filter(line -> !line.substring("import ".length()).replace(";", "").replace("static ", "").matches(allowed))
                    .forEach(line -> foreign.add(name + ": " + line));
        }
        assertEquals(List.of(), foreign);
    }

    @Test
    public void buildFilesStayInsideThisFolder() throws IOException {
        List<String> escaping = new ArrayList<>();
        for (Path file : projectFiles()) {
            String name = file.getFileName().toString();
            boolean build = name.endsWith(".kts") || name.endsWith(".properties") || name.endsWith(".xml");
            if (build && ESCAPING.matcher(read(file)).find()) escaping.add(relative(file));
        }
        assertEquals(List.of(), escaping);
    }

    @Test
    public void textFilesAreAtMostFiveHundredLines() throws IOException {
        List<String> tooLong = new ArrayList<>();
        for (Path file : projectFiles()) {
            if (isText(file) && Files.readAllLines(file, StandardCharsets.UTF_8).size() > MAX_LINES) tooLong.add(relative(file));
        }
        assertTrue("超过 500 行：" + tooLong, tooLong.isEmpty());
    }

    /** 深度优先走登记表，走回正在走的路径上就是循环 */
    private static void visit(String name, List<String> path, Set<String> done) {
        if (done.contains(name)) return;
        assertTrue("循环引用：" + path + " → " + name, !path.contains(name));
        path.add(name);
        for (String next : USES.get(name)) visit(next, path, done);
        path.remove(path.size() - 1);
        done.add(name);
    }

    /** 去掉注释和字符串、字符字面值：注释、日志文字里提到别的类不算引用 */
    static String withoutCommentsAndLiterals(String source) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < source.length()) {
            int next = skip(source, i);
            if (next == i) out.append(source.charAt(i++));
            else {
                out.append(' ');
                i = next;
            }
        }
        return out.toString();
    }

    /** 从 i 开始是注释或字面值就返回它结束的位置，否则返回 i */
    private static int skip(String s, int i) {
        if (s.startsWith("//", i)) {
            int end = s.indexOf('\n', i);
            return end < 0 ? s.length() : end;
        }
        if (s.startsWith("/*", i)) {
            int end = s.indexOf("*/", i + 2);
            return end < 0 ? s.length() : end + 2;
        }
        char c = s.charAt(i);
        if (c != '"' && c != '\'') return i;
        int j = i + 1;
        while (j < s.length() && s.charAt(j) != c) j += s.charAt(j) == '\\' ? 2 : 1;
        return Math.min(j + 1, s.length());
    }

    private static Path source(String name) {
        return APP.resolve("src/main/java/cn/nbyongle/erp/" + name + ".java");
    }

    /** src 下各源码集（main、debug、release……）里的 Java 文件，测试源码集除外 */
    private static List<Path> sourcesOutsideTests() throws IOException {
        try (Stream<Path> files = Files.walk(APP.resolve("src"))) {
            return files.filter(Files::isRegularFile).filter(f -> f.toString().endsWith(".java"))
                    .filter(f -> !APP.relativize(f).toString().replace('\\', '/').matches("src/(test|androidTest)/.*"))
                    .collect(Collectors.toList());
        }
    }

    /** 测试按 android.jar 的 Java 接口编译，没有 Files.readString */
    private static String read(Path file) throws IOException {
        return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    }

    /** 本工程自己的文件，不含构建产物和本机缓存 */
    private static List<Path> projectFiles() throws IOException {
        try (Stream<Path> files = Files.walk(PROJECT)) {
            return files.filter(Files::isRegularFile)
                    .filter(f -> !relative(f).matches("(.*/)?(build|\\.gradle|\\.kotlin|\\.idea)/.*"))
                    .collect(Collectors.toList());
        }
    }

    private static boolean isText(Path file) {
        String name = file.getFileName().toString();
        return name.matches(".*\\.(java|kts|xml|properties|html|css|js|md|ps1|txt)$");
    }

    private static String relative(Path file) {
        return PROJECT.relativize(file).toString().replace('\\', '/');
    }
}

// Tauri 的构建配置入口：按 tauri.conf.json 生成应用上下文、给启动器嵌入图标和清单、把安装资源复制到输出目录。
// 不放业务逻辑（自带页面不嵌入，运行时由 yl 协议从安装目录 pages\ 读）。
fn main() {
    tauri_build::build()
}
